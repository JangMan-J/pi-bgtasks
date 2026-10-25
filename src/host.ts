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
/** Per kind: running now, and finished-failed that nobody has read or been woken with. */
export interface Counts {
	running: number;
	failedUnread: number;
}
interface Host {
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	pending: Map<string, Entry>;
	footer: WeakMap<object, Record<string, string | undefined>>;
	/** Keys currently routed to a zentui template variable instead of `setStatus`. */
	routed: Set<string>;
	counts: () => { bg: Counts; agents: Counts };
	/** Every job store, so ids stay unique across shell tasks and subagents. */
	stores: Set<Map<string, unknown>>;
}

const KEY = Symbol.for("jang.pi.bg.host.v1");
export const host = ((globalThis as Record<symbol, Host>)[KEY] ??= {
	pending: new Map(),
	footer: new WeakMap(),
	routed: new Set(),
	counts: () => ({ bg: { running: 0, failedUnread: 0 }, agents: { running: 0, failedUnread: 0 } }),
	stores: new Set(),
});
// The object outlives /reload; a host made by an older build may lack newer fields.
host.routed ??= new Set();

/** Count one store's jobs for the footer. */
export function count(jobs: Iterable<Notifiable>): Counts {
	let running = 0;
	let failedUnread = 0;
	for (const j of jobs) {
		if (j.status === "running") running++;
		else if (j.status === "failed" && !j.resultObservedAt && !j.notificationDeliveredAt) failedUnread++;
	}
	return { running, failedUnread };
}

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
	publish(); // a read failure leaves the footer
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
 * Footer keys. `status` is the `ctx.ui.setStatus` key every footer extension
 * (zentui, powerline, statusline, Pi's own) places and colours by name.
 * `variable` is the zentui custom-value key a starship template can alias.
 */
export const FOOTER = {
	bg: { status: "bg", variable: "pi-background:bg", noun: "bg" },
	agents: { status: "bg-agents", variable: "pi-background:agents", noun: "agent" },
} as const;

/** `[~] 2 bg` while running; `[!] 1 bg failed` for a failure nobody has looked at; both when both. */
export function label(c: Counts, noun: string): string | undefined {
	const parts: string[] = [];
	if (c.running) parts.push(`[~] ${c.running} ${noun}${noun === "agent" && c.running !== 1 ? "s" : ""}`);
	if (c.failedUnread) parts.push(`[!] ${c.failedUnread} ${noun}${noun === "agent" && c.failedUnread !== 1 ? "s" : ""} failed`);
	return parts.length ? parts.join(" ") : undefined;
}

/**
 * zentui custom-value publisher protocol v1: a template that aliases `key` makes
 * the probe come back `active`. The probe is a plain object zentui mutates in
 * place; no listener means it stays false.
 */
function templateWants(key: string): boolean {
	const probe = { supported: false, active: false, key };
	try {
		(host.pi as any)?.events?.emit?.("zentui:variable-capability", probe);
	} catch {
		return false;
	}
	return probe.supported === true && probe.active === true;
}

/**
 * Footer: one plain, single-line value per key. The universal channel is
 * `ctx.ui.setStatus`, which every footer extension reads and places by key.
 * When a zentui template explicitly aliases the key, the value goes there as a
 * custom variable instead and the `setStatus` copy is cleared, so it never shows
 * twice. No ANSI, no timers; set only on change, removed when empty.
 */
export function publish(): void {
	const ctx = host.ctx;
	try {
		if (!ctx?.hasUI) return;
		const counts = host.counts();
		const prev = host.footer.get(ctx) ?? {};
		const next: Record<string, string | undefined> = {};
		for (const k of ["bg", "agents"] as const) {
			const { status, variable, noun } = FOOTER[k];
			const text = label(counts[k], noun);
			next[k] = text;
			const routed = templateWants(variable);
			const was = host.routed.has(variable);
			if (routed) {
				if (!was || prev[k] !== text) emit("zentui:variable", { key: variable, text });
				if (!was && prev[k] !== undefined) ctx.ui.setStatus(status, undefined);
				host.routed.add(variable);
			} else {
				if (was) emit("zentui:variable", { key: variable, text: undefined });
				if (was || prev[k] !== text) ctx.ui.setStatus(status, text);
				host.routed.delete(variable);
			}
		}
		host.footer.set(ctx, next);
	} catch {
		// Stale or closing UI: nothing to update.
	}
}
