import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as jobs from "./jobs.ts";
import { duration, escapeXml, oneLine, stateLabel, type Status } from "./kit.ts";
import { scheduler } from "./scheduler.ts";

// ---------------------------------------------------------------------------
// Runtime subagent specifications & ephemeral per-session registry.
// ---------------------------------------------------------------------------

/** This extension's own tools. A child never gets them: no recursion, no orphan jobs. */
export const OWN_TOOLS = ["subagent", "bg_run", "bg_logs", "bg_kill"];
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_MAX_TURNS = 30;
export const MAX_RUNNING = 4;
const KILL_WAIT_MS = 5000;
const MAX_RESULT = 32 * 1024;

/** Default tools of a runtime subagent: read-only. */
export const SAFE_TOOLS = ["read", "grep", "find", "ls"];

export const DEFAULT_SYSTEM_PROMPT = [
	"You are a read-only research subagent. Investigate with your tools; you cannot edit files or run commands.",
	"Batch your work: read files in large chunks and group related searches, so turns go to findings, not round trips.",
	"Base every claim on what you observed, and cite file:line. Name what you could not confirm instead of guessing.",
	"Your final message is the only thing the caller receives, so put the complete findings in it. End it with `done` when the whole brief is covered, or `partial` followed by each open item and what blocked it.",
].join("\n");

export interface Declaration {
	name: string;
	description: string;
	/** Exact tool allowlist (names or `*` patterns). Empty means no tools. */
	tools: string[];
	/** `provider/id` (exact), or a bare model id resolved by `resolveModel`. Never inherited from the parent. */
	model: string;
	thinking?: (typeof THINKING)[number];
	maxTurns: number;
	systemPrompt: string;
}

export interface AgentSpecInput {
	agent?: string;
	description?: string;
	tools?: readonly string[] | string;
	model?: string;
	thinking?: string;
	maxTurns?: number;
	systemPrompt?: string;
	save?: boolean;
}

export const SAVED_KEY = Symbol.for("jang.pi.bg.saved.v1");
/** Ephemeral per-session subagent definitions; survives /reload, cleared on session shutdown/switch. */
export const saved: Map<string, Declaration> = ((globalThis as any)[SAVED_KEY] ??= new Map());

const scalar = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2").trim();

function parseToolsInput(rawInput: readonly string[] | string): string[] | string {
	const items = Array.isArray(rawInput)
		? rawInput.map((s) => scalar(String(s).trim())).filter(Boolean)
		: (() => {
				const raw = scalar(String(rawInput)).replace(/^\[(.*)\]$/, "$1").trim();
				return raw === "" || raw === "none" ? [] : raw.split(",").map((s) => scalar(s.trim())).filter(Boolean);
			})();
	if (items.length === 1 && items[0] === "none") return [];
	for (const t of items) {
		if (!/^[\w*:.-]+$/.test(t)) return `invalid tool name: ${oneLine(t)}`;
		if (OWN_TOOLS.includes(t)) return `tool ${t} is not available to subagents`;
	}
	return [...new Set(items)];
}

/** Validate and construct a runtime subagent declaration, merging over a prior session entry if present. */
export function buildDeclaration(input: AgentSpecInput, prior?: Declaration): Declaration | string {
	const name = String(input.agent ?? "").trim();
	if (!/^[A-Za-z][\w-]{0,31}$/.test(name)) return "name must match [A-Za-z][\\w-]{0,31}";

	const description = oneLine(input.description !== undefined ? scalar(String(input.description)) : prior?.description || "Runtime subagent", 200);
	if (!description) return "empty description";

	const tools = input.tools !== undefined ? parseToolsInput(input.tools) : prior ? [...prior.tools] : [...SAFE_TOOLS];
	if (typeof tools === "string") return tools;

	const model = input.model !== undefined ? scalar(String(input.model)) : prior?.model ?? "";
	if (!/^\S+$/.test(model) || model.toLowerCase() === "inherit") {
		return `model must name a model ("provider/id" or a model id); inheriting the parent's model is not supported: ${oneLine(model)}`;
	}

	let thinking: Declaration["thinking"] = prior?.thinking;
	if (input.thinking !== undefined) {
		const t = scalar(String(input.thinking));
		thinking = THINKING.find((x) => x === t);
		if (!thinking) return `thinking must be one of ${THINKING.join(", ")}`;
	}

	let maxTurns = prior?.maxTurns ?? DEFAULT_MAX_TURNS;
	if (input.maxTurns !== undefined) {
		maxTurns = Number(input.maxTurns);
		if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 500) return "maxTurns must be an integer 1-500";
	}

	const systemPrompt = input.systemPrompt !== undefined ? String(input.systemPrompt).trim() : prior?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	if (!systemPrompt) return "empty systemPrompt";

	return { name, description, tools, model, thinking, maxTurns, systemPrompt };
}

/**
 * Resolve a subagent declaration from runtime parameters and the ephemeral session store.
 * Validates the model before saving (ephemeral session save defaults to true; pass `save: false` for one-off).
 */
export function resolveDeclaration(ctx: ExtensionContext, input: AgentSpecInput): { decl: Declaration; note?: string } {
	const name = String(input.agent ?? "").trim();
	const prior = saved.get(name);
	if (!prior && !input.model?.trim()) {
		if (!/^[A-Za-z][\w-]{0,31}$/.test(name)) {
			throw new Error(`Cannot create agent "${oneLine(name)}": name must match [A-Za-z][\\w-]{0,31}`);
		}
		const some = ctx.modelRegistry.getAvailable().slice(0, 20).map((m) => `${m.provider}/${m.id}`).join(", ");
		throw new Error(`Agent "${oneLine(name)}" is not saved in this session. Pass model (provider/id or model id). Available: ${some || "none"}.`);
	}
	const decl = buildDeclaration(input, prior);
	if (typeof decl === "string") {
		throw new Error(`Cannot configure agent "${oneLine(name)}": ${decl}`);
	}
	resolveModel(ctx, decl); // fail before saving anything
	if (input.save !== false) {
		saved.set(decl.name, decl);
	}
	return { decl };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const AGENTS_KEY = Symbol.for("jang.pi.bg.agents.v1");
export const CHANGED = "bg-agents:changed";
export const TERMINAL = "bg-agents:terminal";

export interface AgentRun {
	id: string;
	agent: string;
	name: string;
	model: string;
	status: Status;
	background: boolean;
	startedAt: number;
	completedAt: number | null;
	turns: number;
	toolCalls: number;
	result: string;
	/** Length of the full final answer before the cap. */
	resultChars: number;
	/** Set when this run auto-created its agent declaration. */
	note: string | null;
	error: string | null;
	notifyOnCompletion: boolean;
	resultObservedAt: number | null;
	notificationDeliveredAt: number | null;
	session?: ChildSession;
	abort?: AbortController;
	/** Resolves when the run has finished, or was withdrawn before it started. */
	done?: Promise<void>;
}
export type AgentSnapshot = Omit<AgentRun, "session" | "abort" | "done">;

const snap = ({ session: _s, abort: _a, done: _d, ...rest }: AgentRun): AgentSnapshot => ({ ...rest });

const lane = jobs.lane<AgentRun>({
	name: "agents",
	key: AGENTS_KEY,
	events: { changed: CHANGED, terminal: TERMINAL, field: "run" },
	snapshot: snap,
	summary,
	read: (r) => report(r),
	message,
	stop,
});
export const runs = lane.store;
export const running = lane.running;

export const MAX_QUEUED = 64;
/** Subagent slots, shared across reloads. Tests lower the limit with `queue.setLimit`. */
export const queue = scheduler<AgentRun>({
	key: Symbol.for("jang.pi.bg.queue.v1"),
	max: MAX_RUNNING,
	begin(r) {
		r.status = "running";
		lane.changed(r);
	},
	// Runs an older build started before a /reload still hold their slots.
	foreign: () => running().map((r) => ({ job: r, done: r.done })),
});

/** The slice of an SDK AgentSession this module uses. */
export interface ChildSession {
	prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	subscribe(fn: (event: any) => void): () => void;
	getLastAssistantText(): string | undefined;
	bindExtensions(bindings: object): Promise<void>;
}

export interface Factory {
	create(ctx: ExtensionContext, d: Declaration, model: unknown): Promise<ChildSession>;
}

/**
 * Set while a child session is being built. The child loads extensions itself,
 * including this one; the entry function sees this and installs nothing, so the
 * shared host stays bound to the parent. A counter: children can start concurrently.
 */
export const CHILD_KEY = Symbol.for("jang.pi.bg.child.v1");
export const buildingChild = () => ((globalThis as any)[CHILD_KEY] ?? 0) > 0;

/** Real session factory. The SDK is imported lazily so loading this extension never fails on it. */
const sdkFactory: Factory = {
	async create(ctx, d, model) {
		const g = globalThis as any;
		g[CHILD_KEY] = (g[CHILD_KEY] ?? 0) + 1;
		try {
			return await build(ctx, d, model);
		} finally {
			g[CHILD_KEY]--;
		}
	},
};

async function build(ctx: ExtensionContext, d: Declaration, model: unknown): Promise<ChildSession> {
		const sdk: any = await import("@earendil-works/pi-coding-agent");
		const agentDir = sdk.getAgentDir();
		const settingsManager = sdk.SettingsManager.create(ctx.cwd, agentDir);
		const resourceLoader = new sdk.DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir,
			settingsManager,
			noPromptTemplates: true,
			noThemes: true,
			noSkills: true,
			noContextFiles: true,
			systemPromptOverride: () => d.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const { session } = await sdk.createAgentSession({
			cwd: ctx.cwd,
			agentDir,
			model,
			...(d.thinking ? { thinkingLevel: d.thinking } : {}),
			tools: d.tools,
			excludeTools: OWN_TOOLS,
			sessionManager: sdk.SessionManager.inMemory(ctx.cwd),
			settingsManager,
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
}
let factory: Factory = sdkFactory;
export const setFactory = (f: Factory | undefined) => void (factory = f ?? sdkFactory);

/** 2 = subscription-backed, 1 = OAuth, 0 = API key or other. Pi holds this data; the registry exposes only the OAuth half. */
function rank(ctx: ExtensionContext, m: { provider: string }): number {
	const reg: any = ctx.modelRegistry;
	try {
		if (reg.runtime?.isUsingSubscription?.(m.provider)) return 2;
		return reg.isUsingOAuth?.(m) ? 1 : 0;
	} catch {
		return 0;
	}
}

/**
 * `provider/id` is exact. A bare model id is looked up across every provider with
 * credentials and takes the subscription-backed one; if the best tier still
 * offers it through several providers, that is an error, not a guess.
 */
export function resolveModel(ctx: ExtensionContext, d: Declaration): { model: any; label: string } {
	const reg = ctx.modelRegistry;
	const available = reg.getAvailable();
	const usable = (m: { provider: string; id: string }) => available.some((a) => a.provider === m.provider && a.id === m.id);
	const i = d.model.indexOf("/");
	const exact = i > 0 ? reg.find(d.model.slice(0, i), d.model.slice(i + 1)) : undefined;
	if (exact) {
		if (!usable(exact)) throw new Error(`Agent "${d.name}": model ${d.model} has no configured credentials`);
		return { model: exact, label: `${exact.provider}/${exact.id}` };
	}
	const named = reg.getAll().filter((m) => m.id === d.model);
	if (named.length === 0) throw new Error(`Agent "${d.name}": model ${d.model} does not exist`);
	const ready = named.filter(usable);
	if (ready.length === 0) throw new Error(`Agent "${d.name}": model ${d.model} has no configured credentials`);
	const best = Math.max(...ready.map((m) => rank(ctx, m)));
	const top = ready.filter((m) => rank(ctx, m) === best);
	if (top.length > 1) {
		throw new Error(`Agent "${d.name}": model ${d.model} is ambiguous (${top.map((m) => `${m.provider}/${m.id}`).join(", ")}); use provider/id`);
	}
	return { model: top[0], label: `${top[0].provider}/${top[0].id}` };
}

/**
 * What the caller reads, for every outcome. Always a header, then either the
 * answer or an explicit statement that there is none and why.
 */
export function report(r: AgentRun | AgentSnapshot, max = MAX_RESULT): string {
	const took = duration((r.completedAt ?? Date.now()) - r.startedAt);
	const lines = [
		`subagent ${r.id} (${r.agent}: ${r.name}) ${stateLabel(r).toUpperCase()}`,
		`${r.model} · ${r.turns} turn${r.turns === 1 ? "" : "s"} · ${r.toolCalls} tool call${r.toolCalls === 1 ? "" : "s"} · ${took}`,
	];
	if (r.note) lines.push(r.note);
	if (r.status === "queued") lines.push("", "Queued; waiting for a running slot.");
	else if (r.status === "running") {
		const progress = r.result.slice(0, max);
		if (progress.trim()) {
			lines.push("", `Latest progress (not the final report):\n${progress}`);
			if (r.resultChars > progress.length) {
				lines.push("", `[truncated: showing ${progress.length} of ${r.resultChars} characters${max < MAX_RESULT ? "; read the rest with bg_logs" : ""}]`);
			}
		} else lines.push("", "Still running; no assistant progress yet.");
	} else {
		const answer = r.result.slice(0, max);
		if (r.status === "completed" && !answer.trim()) {
			lines.push("", "NO RESULT: the subagent finished without writing a final answer. Do not assume the work was done; re-run with a prompt that asks for an explicit written report.");
		} else {
			if (r.status === "failed") lines.push("", `FAILED: ${r.error ?? "unknown error"}`);
			if (r.status === "killed") lines.push("", "KILLED before finishing.");
			if (answer.trim()) lines.push("", r.status === "completed" ? answer : `Partial output (the run did not complete):\n${answer}`);
			else lines.push("", "No output was produced.");
			if (r.resultChars > answer.length) {
				lines.push("", `[truncated: showing ${answer.length} of ${r.resultChars} characters${max < MAX_RESULT ? "; read the rest with bg_logs" : ""}]`);
			}
		}
	}
	return lines.join("\n");
}

function message(r: AgentRun) {
	return {
		customType: "bg-notification" as const,
		content: `<subagent-notification>\n${escapeXml(report(r, 4096))}\n</subagent-notification>`,
		display: false as const,
		details: { kind: "agent" as const, id: r.id, name: r.name, status: r.status },
	};
}

async function drive(r: AgentRun, session: ChildSession, d: Declaration, prompt: string): Promise<void> {
	let failure: string | undefined;
	let limited = false;
	let lastText = "";
	const unsub = session.subscribe((e) => {
		if (e?.type === "message_end" && e.message?.role === "assistant") {
			failure = e.message.stopReason === "error" ? e.message.errorMessage || "provider error" : undefined;
			const c = e.message.content;
			const t = (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text ?? "" : "")).join("") : "").trim();
			if (t) {
				lastText = t; // the last message that said anything, not merely the last message
				r.resultChars = t.length;
				r.result = t.slice(0, MAX_RESULT); // live bg_logs reads show this as non-final progress
			}
		} else if (e?.type === "tool_execution_start") {
			r.toolCalls++;
		} else if (e?.type === "turn_end" && ++r.turns >= d.maxTurns && !limited) {
			limited = true;
			void session.abort().catch(() => {});
		}
	});
	const onAbort = () => void session.abort().catch(() => {});
	r.abort!.signal.addEventListener("abort", onAbort, { once: true });
	if (r.abort!.signal.aborted) onAbort(); // killed after the session was built, before this listener
	try {
		await session.prompt(prompt, { expandPromptTemplates: false });
	} catch (e) {
		failure ||= e instanceof Error ? e.message : String(e);
	}
	let full = lastText;
	if (!full) {
		try {
			full = (session.getLastAssistantText() ?? "").trim();
		} catch {
			// no assistant output
		}
	}
	r.resultChars = full.length;
	r.result = full.slice(0, MAX_RESULT);
	let status: "completed" | "failed" | "killed" = "completed";
	if (r.abort!.signal.aborted) status = "killed";
	else if (limited) [status, r.error] = ["failed", `max_turns (${d.maxTurns}) reached`];
	else if (failure) [status, r.error] = ["failed", failure];
	r.abort!.signal.removeEventListener("abort", onAbort);
	unsub();
	try {
		session.dispose();
	} catch {
		// already disposed
	}
	r.session = undefined;
	lane.settle(r, status);
}

export interface SpawnOptions {
	prompt: string;
	background: boolean;
	/** Background only: wake a follow-up turn with the report (default true). */
	notifyOnCompletion?: boolean;
	description?: string;
	/** Shown to the caller with the result. */
	note?: string;
	/** Parent tool-call signal: aborts a foreground child. */
	signal?: AbortSignal;
}

export async function spawn(ctx: ExtensionContext, d: Declaration, o: SpawnOptions): Promise<AgentRun> {
	const prompt = o.prompt?.trim();
	if (!prompt) throw new Error("prompt is empty");
	if (queue.waiting().length >= MAX_QUEUED) throw new Error(`Subagent queue full (max ${MAX_QUEUED}).`);
	const { model, label } = resolveModel(ctx, d);
	const r: AgentRun = {
		id: jobs.newId(),
		agent: d.name,
		name: oneLine(o.description ?? "") || oneLine(prompt, 40),
		model: label,
		status: "queued",
		background: o.background,
		startedAt: Date.now(),
		completedAt: null,
		turns: 0,
		toolCalls: 0,
		result: "",
		resultChars: 0,
		note: o.note ?? null,
		error: null,
		notifyOnCompletion: o.background && o.notifyOnCompletion !== false,
		resultObservedAt: null,
		notificationDeliveredAt: null,
		abort: new AbortController(),
	};
	lane.add(r);
	const create = factory; // the factory at request time, even when the run starts later
	r.done = queue.submit(r, () => run(r, create, ctx, d, model, prompt));
	if (o.signal && !o.background) {
		const onAbort = () => void jobs.kill(r);
		o.signal.addEventListener("abort", onAbort, { once: true });
		void r.done.then(() => o.signal!.removeEventListener("abort", onAbort));
	}
	if (o.signal?.aborted) await jobs.kill(r);
	return r;
}

/** A run's work, from building its session to settling. It holds a scheduler slot throughout. */
async function run(r: AgentRun, create: Factory, ctx: ExtensionContext, d: Declaration, model: unknown, prompt: string): Promise<void> {
	try {
		const session = await create.create(ctx, d, model);
		if (r.abort!.signal.aborted) {
			try {
				session.dispose();
			} catch {
				// already disposed
			}
			lane.settle(r, "killed");
			return;
		}
		r.session = session;
		lane.changed(r);
		await drive(r, session, d, prompt);
	} catch (e) {
		try {
			r.session?.dispose();
		} catch {
			// already disposed
		}
		r.session = undefined;
		if (r.completedAt) return;
		r.error = `could not run: ${e instanceof Error ? e.message : e}`;
		lane.settle(r, r.abort!.signal.aborted ? "killed" : "failed");
	}
}

/**
 * The lane's stop: withdraw a waiting run, or abort a running one and wait
 * briefly for teardown. A teardown that hangs still ends the run as killed;
 * its slot stays held until the work really returns.
 */
async function stop(r: AgentRun): Promise<void> {
	r.abort?.abort();
	if (queue.withdraw(r)) return lane.settle(r, "killed");
	if (r.done) await Promise.race([r.done, new Promise((res) => setTimeout(res, KILL_WAIT_MS).unref())]);
	lane.settle(r, "killed");
}

export function summary(r: AgentRun | AgentSnapshot): string {
	const took = duration((r.completedAt ?? Date.now()) - r.startedAt);
	return `${r.id}  [${stateLabel(r)}]  ${r.agent}: ${r.name} (${r.model}, ${r.turns} turns, ${r.toolCalls} tool calls, ${took})${r.error ? `\n    error: ${oneLine(r.error, 200)}` : ""}`;
}
