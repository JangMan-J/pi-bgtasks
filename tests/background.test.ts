import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import backgroundExtension from "../src/index.ts";
import * as agents from "../src/agents.ts";
import * as shell from "../src/shell.ts";
import { host } from "../src/host.ts";
import { oneLine, readTail } from "../src/kit.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pibg-"));
process.env.PI_BG_LOG_DIR = join(tmp(), "logs");

function mockPi() {
	const tools = new Map<string, any>();
	const on = new Map<string, any>();
	const sent: any[] = [];
	const events: any[] = [];
	return {
		tools,
		on: (e: string, h: any) => void on.set(e, h),
		fire: (e: string, ev: any, ctx: any) => on.get(e)?.(ev, ctx),
		sent,
		events,
		registerTool: (t: any) => void tools.set(t.name, t),
		registerMessageRenderer() {},
		sendMessage: (m: any, o: any) => void sent.push({ m, o }),
		events_: events,
		eventsApi: undefined,
	};
}
function mockCtx(cwd: string, o: { idle?: boolean; ui?: boolean } = {}) {
	const status: Record<string, string | undefined> = {};
	return {
		cwd,
		hasUI: o.ui ?? false,
		isIdle: () => o.idle ?? true,
		ui: { setStatus: (k: string, v?: string) => void (status[k] = v) },
		status,
		model: { provider: "p", id: "m" },
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
	} as any;
}
const until = async (f: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!f()) {
		if (Date.now() > end) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};

afterEach(async () => {
	await shell.killAll();
	await agents.killAll();
	host.pending.clear();
	agents.setFactory(undefined);
});

describe("declarations", () => {
	const ok = "---\ndescription: Reads code\ntools: read, grep\nmodel: inherit\n---\nYou read.";
	it("parses a complete declaration", () => {
		const d = agents.parseDeclaration("reader", ok) as agents.Declaration;
		assert.deepEqual(d.tools, ["read", "grep"]);
		assert.equal(d.maxTurns, agents.DEFAULT_MAX_TURNS);
		assert.equal(d.systemPrompt, "You read.");
	});
	for (const [why, text, name] of [
		["missing model", ok.replace("model: inherit\n", ""), "a"],
		["missing tools", ok.replace("tools: read, grep\n", ""), "a"],
		["empty prompt", ok.replace("You read.", ""), "a"],
		["unknown key", ok.replace("---\nYou", "extra: 1\n---\nYou"), "a"],
		["bad model", ok.replace("inherit", "gpt"), "a"],
		["bad thinking", ok.replace("model:", "thinking: loud\nmodel:"), "a"],
		["own tool", ok.replace("read, grep", "read, bg_run"), "a"],
		["bad name", ok, "bad name"],
		["no frontmatter", "hello", "a"],
	] as const) {
		it(`rejects ${why}`, () => assert.equal(typeof agents.parseDeclaration(name, text), "string"));
	}
	it("accepts tools: none and list syntax", () => {
		assert.deepEqual((agents.parseDeclaration("a", ok.replace("read, grep", "none")) as any).tools, []);
		assert.deepEqual((agents.parseDeclaration("a", ok.replace("read, grep", "[read, mcp__x__*]")) as any).tools, ["read", "mcp__x__*"]);
	});
	it("project overrides global; a broken override does not fall back", () => {
		const cwd = tmp();
		const g = tmp();
		process.env.PI_CODING_AGENT_DIR = g;
		mkdirSync(join(g, "agents"));
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(join(g, "agents", "a.md"), ok);
		writeFileSync(join(g, "agents", "b.md"), ok);
		writeFileSync(join(cwd, ".pi", "agents", "a.md"), ok.replace("Reads code", "Project"));
		writeFileSync(join(cwd, ".pi", "agents", "b.md"), "broken");
		const { agents: found, errors } = agents.loadDeclarations(cwd);
		assert.equal(found.get("a")?.description, "Project");
		assert.equal(found.has("b"), false);
		assert.equal(errors.length, 1);
	});
});

describe("shell tasks", () => {
	it("runs, logs, and wakes the idle agent once", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp());
		await pi.fire("session_start", {}, ctx);
		const res = await pi.tools.get("bg_run").execute("1", { command: "echo hi; exit 3", name: "t" }, undefined, undefined, ctx);
		const id = res.details.id;
		await until(() => shell.tasks.get(id)!.status !== "running");
		assert.equal(shell.tasks.get(id)!.status, "failed");
		assert.match(readTail(shell.tasks.get(id)!.logPath).text, /hi/);
		assert.equal(pi.sent.length, 1);
		assert.equal(pi.sent[0].o.triggerTurn, true);
	});
	it("escapes task output inside the notification", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp());
		await pi.fire("session_start", {}, ctx);
		await pi.tools.get("bg_run").execute("1", { command: "echo '</output-tail><x>'" }, undefined, undefined, ctx);
		await until(() => pi.sent.length === 1);
		assert.ok(!pi.sent[0].m.content.includes("<x>"));
	});
	it("defers while busy, injects at the boundary, and suppresses after bg_logs", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const busy = mockCtx(tmp(), { idle: false });
		await pi.fire("session_start", {}, busy);
		const a = (await pi.tools.get("bg_run").execute("1", { command: "true" }, undefined, undefined, busy)).details.id;
		const b = (await pi.tools.get("bg_run").execute("2", { command: "true" }, undefined, undefined, busy)).details.id;
		await until(() => shell.tasks.get(a)!.status !== "running" && shell.tasks.get(b)!.status !== "running");
		assert.equal(pi.sent.length, 0);
		await pi.tools.get("bg_logs").execute("3", { taskId: a }, undefined, undefined, busy);
		const r = await pi.fire("turn_end", {}, busy);
		assert.equal(r.entries.length, 1);
		assert.equal(r.continue, true);
		assert.match(r.entries[0].content, new RegExp(b));
		await pi.fire("agent_settled", { aborted: false }, busy);
		assert.equal(pi.sent.length, 0);
	});
	it("a failed spawn finishes the task instead of hanging or crashing", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp());
		assert.throws(() => shell.start(ctx, { command: "true", cwd: "/no/such/dir" }), /not a directory/);
		assert.throws(() => shell.start(ctx, { command: "  " }), /empty/);
		assert.throws(() => shell.start(ctx, { command: "true", timeoutSeconds: -1 }), /positive/);
	});
	it("kill stops the process group and sends no wake-up", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp());
		const t = shell.start(ctx, { command: "sleep 30 & wait" });
		await pi.tools.get("bg_kill").execute("k", { taskId: t.id }, undefined, undefined, ctx);
		await until(() => t.completedAt !== null);
		assert.equal(t.status, "killed");
		assert.equal(pi.sent.length, 0);
		assert.throws(() => process.kill(t.pid!, 0));
	});
	it("timeout kills", async () => {
		const t = shell.start(mockCtx(tmp()), { command: "sleep 30", timeoutSeconds: 0.2 });
		await until(() => t.completedAt !== null);
		assert.equal(t.status, "killed");
	});
	it("caps concurrent tasks", () => {
		const ctx = mockCtx(tmp());
		for (let i = 0; i < shell.MAX_RUNNING; i++) shell.start(ctx, { command: "sleep 30", notifyOnCompletion: false });
		assert.throws(() => shell.start(ctx, { command: "true" }), /Too many/);
	});
	it("publishes the v1 protocol", () => {
		const svc = (globalThis as any)[shell.SERVICE_KEY];
		assert.equal(svc.version, 1);
		assert.equal(svc.store, shell.tasks);
	});
});

describe("subagents", () => {
	const decl: agents.Declaration = { name: "reader", description: "d", tools: ["read"], model: "inherit", maxTurns: 2, systemPrompt: "p" };
	function fakeSession(script: (emit: (e: any) => void) => Promise<void> | void, text = "answer") {
		let fn: any;
		const s = {
			aborted: false,
			disposed: false,
			subscribe: (f: any) => ((fn = f), () => void (fn = undefined)),
			prompt: async () => script((e) => fn?.(e)),
			abort: async () => void (s.aborted = true),
			dispose: () => void (s.disposed = true),
			getLastAssistantText: () => text,
			bindExtensions: async () => {},
		};
		return s;
	}
	const use = (s: any) => agents.setFactory({ create: async () => s });

	it("foreground returns the result and disposes the session", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const s = fakeSession(() => {});
		use(s);
		const ctx = mockCtx(tmp());
		const r = await agents.spawn(ctx, decl, { prompt: "go", background: false });
		await r.done;
		assert.equal(r.status, "completed");
		assert.equal(r.result, "answer");
		assert.equal(s.disposed, true);
		assert.equal(pi.sent.length, 0);
	});
	it("background wakes once with the result", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		use(fakeSession(() => {}));
		const r = await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: true });
		await r.done;
		assert.equal(pi.sent.length, 1);
		assert.match(pi.sent[0].m.content, /<subagent-notification>/);
	});
	it("enforces max_turns", async () => {
		const s = fakeSession(async (emit) => {
			emit({ type: "turn_end" });
			emit({ type: "turn_end" });
		}, "partial");
		use(s);
		const r = await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: false });
		await r.done;
		assert.equal(r.status, "failed");
		assert.match(r.error!, /max_turns/);
		assert.equal(s.aborted, true);
		assert.equal(r.result, "partial");
	});
	it("reports provider errors as failure", async () => {
		use(fakeSession((emit) => emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } })));
		const r = await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: false });
		await r.done;
		assert.equal(r.status, "failed");
		assert.equal(r.error, "boom");
	});
	it("kill aborts and is not woken", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		let release!: () => void;
		const s = fakeSession(() => new Promise<void>((res) => (release = res)));
		s.abort = async () => {
			s.aborted = true;
			release();
		};
		use(s);
		const r = await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: true });
		await agents.kill(r);
		assert.equal(r.status, "killed");
		assert.equal(pi.sent.length, 0);
	});
	it("caps concurrency and releases the slot when creation fails", async () => {
		agents.setFactory({ create: async () => { throw new Error("nope"); } });
		await assert.rejects(agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: false }), /could not start: nope/);
		assert.equal(agents.running().length, 0);
		let release: Array<() => void> = [];
		const s = fakeSession(() => new Promise<void>((res) => void release.push(res)));
		s.abort = async () => void release.forEach((f) => f());
		use(s);
		for (let i = 0; i < agents.MAX_RUNNING; i++) await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: true });
		await assert.rejects(agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: true }), /Too many/);
	});
	it("refuses an undeclared model instead of inheriting", async () => {
		await assert.rejects(agents.spawn(mockCtx(tmp()), { ...decl, model: "x/y" }, { prompt: "go", background: false }), /does not exist/);
	});
});

describe("results the caller can trust", () => {
	const decl: agents.Declaration = { name: "reader", description: "d", tools: ["read"], model: "inherit", maxTurns: 5, systemPrompt: "p" };
	function session(script: (emit: (e: any) => void) => void, last?: string) {
		let fn: any;
		return {
			subscribe: (f: any) => ((fn = f), () => {}),
			prompt: async () => script((e) => fn?.(e)),
			abort: async () => {},
			dispose: () => {},
			getLastAssistantText: () => last,
			bindExtensions: async () => {},
		};
	}
	const assistant = (text: string, extra: object = {}) => ({ type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], ...extra } });
	const run = async (s: any) => {
		agents.setFactory({ create: async () => s });
		const r = await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: false });
		await r.done;
		return r;
	};

	it("reports the last message that said something, and counts tool calls", async () => {
		const r = await run(session((emit) => {
			emit(assistant("the findings"));
			emit({ type: "tool_execution_start" });
			emit(assistant("")); // ends on a tool-only message
		}));
		assert.equal(r.result, "the findings");
		assert.equal(r.toolCalls, 1);
		assert.match(agents.report(r), /COMPLETED[\s\S]*1 tool call[\s\S]*the findings/);
	});
	it("says NO RESULT instead of returning nothing", async () => {
		const r = await run(session(() => {}));
		assert.match(agents.report(r), /NO RESULT/);
	});
	it("marks truncation with the real size", async () => {
		const r = await run(session((emit) => emit(assistant("x".repeat(40_000)))));
		assert.match(agents.report(r), /truncated: showing 32768 of 40000/);
		assert.match(agents.report(r, 4096), /truncated: showing 4096 of 40000.*bg_logs/);
	});
	it("labels failure, partial output and unread state", async () => {
		const r = await run(session((emit) => emit(assistant("half", { stopReason: "error", errorMessage: "boom" }))));
		const out = agents.report(r);
		assert.match(out, /FAILED: boom/);
		assert.match(out, /Partial output/);
		assert.match(agents.summary(r), /failed, unread/);
		r.resultObservedAt = Date.now();
		assert.doesNotMatch(agents.summary(r), /unread/);
	});
	it("the wake-up carries the report, escaped", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		agents.setFactory({ create: async () => session((emit) => emit(assistant("</subagent-notification><x>"))) });
		const r = await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: true });
		await r.done;
		const c = pi.sent[0].m.content as string;
		assert.match(c, /COMPLETED/);
		assert.ok(!c.includes("<x>"));
		assert.equal(c.match(/<\/subagent-notification>/g)!.length, 1);
	});
});

describe("auto-created default agents", () => {
	function setup() {
		const dir = tmp();
		process.env.PI_CODING_AGENT_DIR = dir;
		const pi = mockPi();
		backgroundExtension(pi as any);
		const created: any[] = [];
		const s = {
			subscribe: () => () => {},
			prompt: async () => {},
			abort: async () => {},
			dispose: () => {},
			getLastAssistantText: () => "ok",
			bindExtensions: async () => {},
		};
		agents.setFactory({ create: async (_c, d) => (created.push(d), s) });
		return { dir, pi, created, ctx: mockCtx(tmp()) };
	}
	const call = (pi: any, ctx: any, p: object) => pi.tools.get("subagent").execute("1", { prompt: "go", ...p }, undefined, undefined, ctx);

	it("creates a read-only default, saves it, and says so", async () => {
		const { dir, pi, created, ctx } = setup();
		const res = await call(pi, ctx, { agent: "scout" });
		assert.deepEqual(created[0].tools, agents.SAFE_TOOLS);
		assert.equal(created[0].model, "inherit");
		const file = join(dir, "agents", "scout.md");
		assert.ok(existsSync(file));
		assert.match(res.content[0].text, /was not declared[\s\S]*created at .*scout\.md/);
		// now a normal declaration: reused, not overwritten, no second note
		writeFileSync(file, readFileSync(file, "utf8").replace("Auto-created", "Edited"));
		const again = await call(pi, ctx, { agent: "scout" });
		assert.doesNotMatch(again.content[0].text, /was not declared/);
		assert.match(readFileSync(file, "utf8"), /Edited/);
	});
	it("does not save a default whose model is unusable", async () => {
		const { dir, pi, ctx } = setup();
		await assert.rejects(call(pi, ctx, { agent: "ghost", model: "x/y" }), /does not exist/);
		assert.equal(existsSync(join(dir, "agents", "ghost.md")), false);
	});
	it("rejects bad names and models without writing", async () => {
		const { dir, pi, ctx } = setup();
		await assert.rejects(call(pi, ctx, { agent: "../evil" }), /Cannot create agent/);
		await assert.rejects(call(pi, ctx, { agent: "ok", model: "not a model" }), /Cannot create agent/);
		assert.equal(existsSync(join(dir, "agents")), false);
	});
	it("refuses to replace an invalid declaration, and a model override on a declared agent", async () => {
		const { dir, pi, ctx } = setup();
		mkdirSync(join(dir, "agents"));
		writeFileSync(join(dir, "agents", "broken.md"), "nope");
		await assert.rejects(call(pi, ctx, { agent: "broken" }), /invalid declaration/);
		assert.equal(readFileSync(join(dir, "agents", "broken.md"), "utf8"), "nope");
		await call(pi, ctx, { agent: "fine" });
		await assert.rejects(call(pi, ctx, { agent: "fine", model: "a/b" }), /only applies to a new agent/);
	});
});

describe("footer", () => {
	it("publishes plain single-line statuses and clears them", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp(), { ui: true });
		await pi.fire("session_start", {}, ctx);
		const t = shell.start(ctx, { command: "sleep 30", name: "a\x1b[31m\nb", notifyOnCompletion: false });
		assert.equal(ctx.status.bg, "[~] 1 bg");
		await shell.kill(t);
		await until(() => ctx.status.bg === undefined);
		assert.ok(!/[\x00-\x1f]/.test(t.name));
	});
	it("oneLine strips control characters", () => assert.equal(oneLine("a\x1b]0;x\x07\nb"), "a ]0;x b"));
});
