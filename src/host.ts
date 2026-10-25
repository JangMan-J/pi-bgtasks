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
	/** Last text published per UI context, so unchanged frames are not re-sent. */
	footer: WeakMap<object, string>;
	/** Spinner: current frame and the interval driving it while anything runs. */
	frame: number;
	spinner?: ReturnType<typeof setInterval>;
	/** Set while the session shuts down, so late callbacks do not repaint a cleared footer. */
	closed?: boolean;
	counts: () => { bg: Counts; agents: Counts };
	/** Every job store, so ids stay unique across shell tasks and subagents. */
	stores: Set<Map<string, unknown>>;
}

const KEY = Symbol.for("jang.pi.bg.host.v1");
export const host = ((globalThis as Record<symbol, Host>)[KEY] ??= {
	pending: new Map(),
	footer: new WeakMap(),
	frame: 0,
	counts: () => ({ bg: { running: 0, failedUnread: 0 }, agents: { running: 0, failedUnread: 0 } }),
	stores: new Set(),
});

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

host.frame ??= 0; // the object outlives /reload; older builds lack this field
// A /reload loads this module again: take the spinner over so the old module's
// interval stops driving the footer. The first publish() restarts it if needed.
if (host.spinner) {
	clearInterval(host.spinner);
	host.spinner = undefined;
}

/** Start the spinner while anything runs; stop and reset it when nothing does. */
function spin(busy: boolean): void {
	if (busy && !host.spinner) {
		host.spinner = setInterval(() => {
			host.frame = (host.frame + 1) % FRAMES.length;
			publish();
		}, SPIN_MS);
		host.spinner.unref?.();
	} else if (!busy && host.spinner) {
		clearInterval(host.spinner);
		host.spinner = undefined;
		host.frame = 0;
	}
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
 * One footer key for the whole extension, so a user places it once. `status`
 * is the `ctx.ui.setStatus` key every footer extension (Pi's own, zentui,
 * powerline, statusline, starship styles) places and colours by name;
 * `variable` is the zentui custom-value key a starship template can alias.
 * Two lanes inside it: shell tasks and subagents.
 */
export const FOOTER = { status: "bg", variable: "pi-background:bg" } as const;
export const LANES = {
	bg: { icon: "\uf120", code: 45 },
	agents: { icon: "\uf21b", code: 141 },
} as const;

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const color = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;
const SPIN_MS = 120;

/**
 * Same recipe as pi-webtasks: nerd-font icon, 256-colour, compact count, a
 * braille spinner frame while anything runs. Failures nobody has looked at
 * follow in red. Idle is a dim `icon 0`, present from session start, so the
 * footer keeps its shape instead of shifting when work begins.
 */
export function label(c: Counts, icon: string, code: number, frame = 0): string {
	const parts: string[] = [];
	if (c.running) parts.push(color(code, `${icon} ${c.running}${FRAMES[frame % FRAMES.length]}`));
	else parts.push(color(240, `${icon} 0`));
	if (c.failedUnread) parts.push(color(203, `\uf071 ${c.failedUnread}`));
	return parts.join("  ");
}

/** The one status line: shell lane, then agent lane. */
export function compose(counts: { bg: Counts; agents: Counts }, frame = 0): string {
	return [label(counts.bg, LANES.bg.icon, LANES.bg.code, frame), label(counts.agents, LANES.agents.icon, LANES.agents.code, frame)].join("  ");
}

/**
 * Footer: one single-line value under one key, always present while the
 * session is open, set only on change. A spinner timer runs only while
 * something is running. Two channels, always both:
 *  - `ctx.ui.setStatus("bg")`: the contract every footer extension (Pi's own,
 *    zentui, powerline, statusline, starship styles) reads and places by key.
 *  - zentui custom-value protocol v1 under `pi-background:bg`: ignored unless a
 *    starship template aliases it. A user who aliases it turns the `bg` status
 *    key Off in /zentui extensions, so it is not shown twice.
 */
export function publish(): void {
	const ctx = host.ctx;
	try {
		if (!ctx?.hasUI || host.closed) return;
		const counts = host.counts();
		spin(counts.bg.running + counts.agents.running > 0);
		const text = compose(counts, host.frame);
		if (host.footer.get(ctx) === text) return;
		host.footer.set(ctx, text);
		ctx.ui.setStatus(FOOTER.status, text);
		emit("zentui:variable", { key: FOOTER.variable, text });
	} catch {
		// Stale or closing UI: nothing to update.
	}
}

/** Session end: remove both keys and stop the spinner. */
export function clear(): void {
	host.closed = true;
	spin(false);
	const ctx = host.ctx;
	try {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(FOOTER.status, undefined);
		emit("zentui:variable", { key: FOOTER.variable, text: undefined });
		host.footer.delete(ctx);
	} catch {
		// UI already gone.
	}
}
