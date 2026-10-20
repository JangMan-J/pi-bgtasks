import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emit, host, publish, taken, terminal } from "./host.ts";
import { duration, escapeXml, newId, oneLine, stateLabel, type Status } from "./kit.ts";

// ---------------------------------------------------------------------------
// Declarations: a subagent exists only if a file declares it completely.
// ---------------------------------------------------------------------------

/** This extension's own tools. A child never gets them: no recursion, no orphan jobs. */
export const OWN_TOOLS = ["subagent", "bg_run", "bg_logs", "bg_kill"];
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_MAX_TURNS = 30;
export const MAX_RUNNING = 4;
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

export function agentDirs(cwd: string): string[] {
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
		"You are a read-only research subagent. Use only your tools to investigate the task; you cannot edit files or run commands.",
		"Your final message is the only thing the caller receives: put your complete findings in it. If you could not find or finish something, say so plainly.",
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
	done?: Promise<void>;
}
export type AgentSnapshot = Omit<AgentRun, "session" | "abort" | "done">;

const g = globalThis as Record<symbol, any>;
export const runs: Map<string, AgentRun> = (g[AGENTS_KEY] ??= new Map());
host.stores.add(runs);
const snap = ({ session: _s, abort: _a, done: _d, ...rest }: AgentRun): AgentSnapshot => ({ ...rest });
export const running = () => [...runs.values()].filter((r) => r.status === "running");

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

/** Real session factory. The SDK is imported lazily so loading this extension never fails on it. */
export const sdkFactory: Factory = {
	async create(ctx, d, model) {
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
	},
};
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
	if (r.status === "running") lines.push("", "Still running; no result yet.");
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
		display: true as const,
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
	if (r.abort!.signal.aborted) r.status = "killed";
	else if (limited) [r.status, r.error] = ["failed", `max_turns (${d.maxTurns}) reached`];
	else if (failure) [r.status, r.error] = ["failed", failure];
	else r.status = "completed";
	r.abort!.signal.removeEventListener("abort", onAbort);
	unsub();
	try {
		session.dispose();
	} catch {
		// already disposed
	}
	r.session = undefined;
	r.completedAt = Date.now();
	publish();
	emit(CHANGED, { version: 1, run: snap(r) });
	emit(TERMINAL, { version: 1, run: snap(r) });
	terminal(r, () => message(r));
}

export interface SpawnOptions {
	prompt: string;
	background: boolean;
	description?: string;
	/** Shown to the caller with the result. */
	note?: string;
	/** Parent tool-call signal: aborts a foreground child. */
	signal?: AbortSignal;
}

function prune(): void {
	const done = [...runs.values()].filter((r) => r.status !== "running").sort((a, b) => a.completedAt! - b.completedAt!);
	for (const r of done.slice(0, Math.max(0, done.length - 32))) runs.delete(r.id);
}

export async function spawn(ctx: ExtensionContext, d: Declaration, o: SpawnOptions): Promise<AgentRun> {
	const prompt = o.prompt?.trim();
	if (!prompt) throw new Error("prompt is empty");
	if (running().length >= MAX_RUNNING) throw new Error(`Too many running subagents (max ${MAX_RUNNING}). Wait or bg_kill one.`);
	const { model, label } = resolveModel(ctx, d);
	// Reserve the slot before the async session build so concurrent calls cannot exceed the cap.
	prune();
	const r: AgentRun = {
		id: newId(taken),
		agent: d.name,
		name: oneLine(o.description ?? "") || oneLine(prompt, 40),
		model: label,
		status: "running",
		background: o.background,
		startedAt: Date.now(),
		completedAt: null,
		turns: 0,
		toolCalls: 0,
		result: "",
		resultChars: 0,
		note: o.note ?? null,
		error: null,
		notifyOnCompletion: o.background,
		resultObservedAt: null,
		notificationDeliveredAt: null,
		abort: new AbortController(),
	};
	runs.set(r.id, r);
	publish();
	let session: ChildSession;
	try {
		session = await factory.create(ctx, d, model);
	} catch (e) {
		runs.delete(r.id);
		publish();
		throw new Error(`Agent "${d.name}": could not start: ${e instanceof Error ? e.message : e}`);
	}
	if (r.abort!.signal.aborted) {
		// Killed while the session was being built.
		try {
			session.dispose();
		} catch {
			// ignore
		}
		r.status = "killed";
		r.completedAt = Date.now();
		publish();
		return r;
	}
	r.session = session;
	emit(CHANGED, { version: 1, run: snap(r) });
	r.done = drive(r, session, d, prompt).catch((e) => {
		if (r.status !== "running") return;
		r.status = "failed";
		r.error = e instanceof Error ? e.message : String(e);
		r.completedAt = Date.now();
		publish();
		terminal(r, () => message(r));
	});
	if (o.signal) {
		if (o.signal.aborted) r.abort!.abort();
		else if (!o.background) o.signal.addEventListener("abort", () => r.abort!.abort(), { once: true });
	}
	return r;
}

/** Stop a run. No wake-up; the result counts as seen. Waits briefly for teardown. */
export async function kill(r: AgentRun): Promise<void> {
	if (r.status === "running") {
		r.notifyOnCompletion = false;
		r.abort?.abort();
		await Promise.race([r.done, new Promise((res) => setTimeout(res, 5000).unref())]);
		if (r.status === "running") r.status = "killed"; // teardown wedged: report the intent
	}
	r.resultObservedAt ??= Date.now();
	publish();
}

export async function killAll(): Promise<void> {
	await Promise.all(running().map(kill));
}

export function summary(r: AgentRun | AgentSnapshot): string {
	const took = duration((r.completedAt ?? Date.now()) - r.startedAt);
	return `${r.id}  [${stateLabel(r)}]  ${r.agent}: ${r.name} (${r.model}, ${r.turns} turns, ${r.toolCalls} tool calls, ${took})${r.error ? `\n    error: ${oneLine(r.error, 200)}` : ""}`;
}
