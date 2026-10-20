/**
 * Shared host state: the live `pi`/`ctx`, queued notifications, and footer
 * publishing. It lives on globalThis so child-process and session callbacks
 * created before a /reload reach the *current* extension instance instead of
 * a stale one.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { escapeXml, type Notifiable } from "./kit.ts";

export interface Message {
	customType: "bg-notification";
	content: string;
	display: true;
	details: { kind: "shell" | "agent"; id: string; name: string; status: string };
}

interface Entry {
	job: Notifiable;
	build: () => Message;
}
interface Host {
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	pending: Map<string, Entry>;
	footer: WeakMap<object, Record<string, string | undefined>>;
	counts: () => { bg: number; agents: number };
	/** Every job store, so ids stay unique across shell tasks and subagents. */
	stores: Set<Map<string, unknown>>;
}

const KEY = Symbol.for("jang.pi.bg.host.v1");
export const host = ((globalThis as Record<symbol, Host>)[KEY] ??= {
	pending: new Map(),
	footer: new WeakMap(),
	counts: () => ({ bg: 0, agents: 0 }),
	stores: new Set(),
});

export const taken = (id: string) => [...host.stores].some((m) => m.has(id));

export function emit(event: string, payload: unknown): void {
	try {
		(host.pi as any)?.events?.emit?.(event, payload);
	} catch {
		// Event bus unavailable (stale instance, tests).
	}
}

export function notification(
	tag: "background-task-notification",
	fields: Record<string, string | number | null>,
	bodyTag: string,
	body: string,
	truncated: boolean,
): string {
	const head = Object.entries(fields).map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`);
	return [
		`<${tag}>`,
		...head,
		`<${bodyTag}${truncated ? ' truncated="true"' : ""}>`,
		escapeXml(body),
		`</${bodyTag}>`,
		`</${tag}>`,
	].join("\n");
}

const due = (j: Notifiable) =>
	j.notifyOnCompletion && j.status !== "running" && !j.resultObservedAt && !j.notificationDeliveredAt;

/** The agent has seen this result (bg_logs); suppress its wake. */
export function observed(job: Notifiable): void {
	if (job.status === "running") return;
	job.resultObservedAt ??= Date.now();
	host.pending.delete(job.id);
}

function idle(): boolean {
	try {
		return host.ctx?.isIdle?.() ?? true;
	} catch {
		return true;
	}
}

function send(e: Entry): void {
	const { job } = e;
	job.notificationDeliveredAt = Date.now();
	host.pending.delete(job.id);
	const undo = () => {
		job.notificationDeliveredAt = null;
		host.pending.set(job.id, e);
	};
	try {
		const r: any = host.pi?.sendMessage(e.build(), { triggerTurn: true, deliverAs: "followUp" });
		if (r && typeof r.catch === "function") r.catch(undo);
		else if (!host.pi) undo();
	} catch {
		undo();
	}
}

/** A job reached a terminal state. Wake the agent now if idle, else at the next boundary. */
export function terminal(job: Notifiable, build: () => Message): void {
	if (!due(job)) return;
	if (idle()) send({ job, build });
	else host.pending.set(job.id, { job, build });
}

/** Turn-boundary injection: results ride the current run and force one more request. */
export function boundary() {
	const entries: Array<Record<string, unknown>> = [];
	for (const [id, e] of [...host.pending]) {
		host.pending.delete(id);
		if (!due(e.job)) continue;
		e.job.notificationDeliveredAt = Date.now();
		entries.push({ type: "custom_message", ...e.build() });
	}
	return entries.length ? { entries, continue: true } : undefined;
}

/** Run settled normally: wake for anything still queued. */
export function flush(): void {
	for (const e of [...host.pending.values()]) {
		if (due(e.job)) send(e);
		else host.pending.delete(e.job.id);
	}
}

/**
 * Footer: one plain, single-line status per key. Plain text lets themed footers
 * (zentui, starship) style and place it; an unset key is removed from the footer.
 */
export function publish(): void {
	const ctx = host.ctx;
	try {
		if (!ctx?.hasUI) return;
		const { bg, agents } = host.counts();
		const next = {
			bg: bg ? `[~] ${bg} bg` : undefined,
			agents: agents ? `[~] ${agents} agent${agents === 1 ? "" : "s"}` : undefined,
		};
		const prev = host.footer.get(ctx) ?? {};
		for (const [k, key] of [["bg", "bg"], ["agents", "bg-agents"]] as const) {
			if (prev[k] !== next[k]) ctx.ui.setStatus(key, next[k]);
		}
		host.footer.set(ctx, next);
	} catch {
		// Stale or closing UI: nothing to update.
	}
}
