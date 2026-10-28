import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as jobs from "./jobs.ts";
import { duration, escapeXml, oneLine, stateLabel, type Status } from "./kit.ts";
import { scheduler } from "./scheduler.ts";

// ---------------------------------------------------------------------------
// Declarations: a subagent exists only if a file declares it completely.
// ---------------------------------------------------------------------------

/** This extension's own tools. A child never gets them: no recursion, no orphan jobs. */
export const OWN_TOOLS = ["subagent", "bg_run", "bg_logs", "bg_kill"];
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_MAX_TURNS = 30;
export const MAX_RUNNING = 4;
const KILL_WAIT_MS = 5000;
const MAX_RESULT = 32 * 1024;
const KEYS = ["description", "tools", "model", "thinking", "max_turns"];

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

const scalar = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2").trim();

/** Flat `key: value` frontmatter. Strict: anything else is an error. */
function split(text: string): { fm: Map<string, string>; body: string } | string {
	const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
	if (!m) return "missing --- frontmatter";
	const fm = new Map<string, string>();
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const kv = /^([a-z_]+):[ \t]*(.*)$/.exec(line);
		if (!kv) return `unparseable frontmatter line: ${oneLine(line)}`;
		if (fm.has(kv[1])) return `duplicate key: ${kv[1]}`;
		fm.set(kv[1], kv[2]);
	}
	return { fm, body: (m[2] ?? "").trim() };
}

export function parseDeclaration(name: string, text: string): Declaration | string {
	if (!/^[A-Za-z][\w-]{0,31}$/.test(name)) return "name must match [A-Za-z][\\w-]{0,31}";
	const parts = split(text);
	if (typeof parts === "string") return parts;
	const { fm, body } = parts;
	for (const k of fm.keys()) if (!KEYS.includes(k)) return `unknown key: ${k}`;
	for (const k of ["description", "tools", "model"]) if (!fm.has(k)) return `missing required key: ${k}`;
	if (!body) return "empty system prompt (the body after the frontmatter)";

	const description = oneLine(scalar(fm.get("description")!), 200);
	if (!description) return "empty description";

	const raw = scalar(fm.get("tools")!).replace(/^\[(.*)\]$/, "$1").trim();
	const tools = raw === "" || raw === "none" ? [] : raw.split(",").map((s) => scalar(s.trim()));
	for (const t of tools) {
		if (!/^[\w*:.-]+$/.test(t)) return `invalid tool name: ${oneLine(t)}`;
		if (OWN_TOOLS.includes(t)) return `tool ${t} is not available to subagents`;
	}

	const model = scalar(fm.get("model")!);
	if (!/^\S+$/.test(model) || model.toLowerCase() === "inherit") {
		return `model must name a model ("provider/id" or a model id); inheriting the parent's model is not supported: ${oneLine(model)}`;
	}

	let thinking: Declaration["thinking"];
	if (fm.has("thinking")) {
		const t = scalar(fm.get("thinking")!);
		thinking = THINKING.find((x) => x === t);
		if (!thinking) return `thinking must be one of ${THINKING.join(", ")}`;
	}

	let maxTurns = DEFAULT_MAX_TURNS;
	if (fm.has("max_turns")) {
		maxTurns = Number(scalar(fm.get("max_turns")!));
		if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 500) return "max_turns must be an integer 1-500";
	}
	return { name, description, tools: [...new Set(tools)], model, thinking, maxTurns, systemPrompt: body };
}

function agentDirs(cwd: string): string[] {
	const global = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "agents");
	return [global, join(cwd, ".pi", "agents")]; // later wins
}

/** Read declarations from disk on every call so edits apply without a reload. */
export function loadDeclarations(cwd: string): { agents: Map<string, Declaration>; errors: string[]; invalid: Set<string> } {
	const agents = new Map<string, Declaration>();
	const errors: string[] = [];
	const invalid = new Set<string>();
	for (const dir of agentDirs(cwd)) {
		if (!existsSync(dir)) continue;
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
		} catch (e) {
			errors.push(`${dir}: ${e instanceof Error ? e.message : e}`);
		}
		for (const f of files) {
			const name = basename(f, ".md");
			try {
				const d = parseDeclaration(name, readFileSync(join(dir, f), "utf8"));
				if (typeof d === "string") {
					agents.delete(name); // a broken override must not fall back to the file it shadows
					invalid.add(name);
					errors.push(`${join(dir, f)}: ${d}`);
				} else agents.set(name, d);
			} catch (e) {
				invalid.add(name);
				errors.push(`${join(dir, f)}: ${e instanceof Error ? e.message : e}`);
			}
		}
	}
	return { agents, errors, invalid };
}

/** Tools of an auto-created agent: read-only. */
export const SAFE_TOOLS = ["read", "grep", "find", "ls"];

/**
 * An undeclared agent name gets a safe default: read-only tools and a prompt that
 * demands a written final answer. It is written to the global agents directory so
 * it becomes a real, editable declaration; an existing file is never overwritten.
 */
export function defaultDeclaration(name: string, model: string): { decl: Declaration; text: string } {
	const text = [
		"---",
		"description: Auto-created read-only default agent",
		`tools: ${SAFE_TOOLS.join(", ")}`,
		`model: ${model}`,
		`max_turns: ${DEFAULT_MAX_TURNS}`,
		"---",
		"You are a read-only research subagent. Investigate with your tools; you cannot edit files or run commands.",
		"Batch your work: read files in large chunks and group related searches, so turns go to findings, not round trips.",
		"Base every claim on what you observed, and cite file:line. Name what you could not confirm instead of guessing.",
		"Your final message is the only thing the caller receives, so put the complete findings in it. End it with `done` when the whole brief is covered, or `partial` followed by each open item and what blocked it.",
		"",
	].join("\n");
	const decl = parseDeclaration(name, text);
	if (typeof decl === "string") throw new Error(`Cannot create agent "${oneLine(name)}": ${decl}`);
	return { decl, text };
}

/** Save a default as a real declaration. Never overwrites; null when it could not be saved. */
export function saveDeclaration(cwd: string, name: string, text: string): string | null {
	try {
		const dir = agentDirs(cwd)[0];
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${name}.md`);
		writeFileSync(path, text, { flag: "wx", mode: 0o644 });
		return path;
	} catch {
		return null;
	}
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
	else if (r.status === "running") lines.push("", "Still running; no result yet.");
	else {
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
			if (t) lastText = t; // the last message that said anything, not merely the last message
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
