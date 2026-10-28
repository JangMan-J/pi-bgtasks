import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import backgroundExtension from "../src/index.ts";
import * as agents from "../src/agents.ts";
import * as shell from "../src/shell.ts";
import { host, notifier } from "../src/host.ts";
import { createFooter, label } from "../src/footer.ts";
import { createNotifier } from "../src/notifier.ts";
import * as jobs from "../src/jobs.ts";
import { scheduler } from "../src/scheduler.ts";
import { oneLine, readTail, type Job, type Status } from "../src/kit.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pibg-"));
process.env.PI_BG_LOG_DIR = join(tmp(), "logs");

function mockPi() {
	const tools = new Map<string, any>();
	const on = new Map<string, any>();
	const sent: any[] = [];
	return {
		tools,
		on: (e: string, h: any) => void on.set(e, h),
		fire: (e: string, ev: any, ctx: any) => on.get(e)?.(ev, ctx),
		sent,
		registerTool: (t: any) => void tools.set(t.name, t),
		sendMessage: (m: any, o: any) => void sent.push({ m, o }),
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
		modelRegistry: {
			find: (p: string, i: string) => (p === "p" && i === "m" ? { provider: "p", id: "m" } : undefined),
			getAll: () => [{ provider: "p", id: "m" }],
			getAvailable: () => [{ provider: "p", id: "m" }],
		},
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
	await jobs.killAll();
	notifier.drop();
	agents.setFactory(undefined);
});

/** A recording adapter of the Pi port, with a manual clock. */
function fakePort(o: { idle?: boolean; ui?: boolean } = {}) {
	const f = {
		idle: o.idle ?? true,
		hasUI: o.ui ?? true,
		fail: undefined as undefined | "throw" | "reject",
		sent: [] as any[],
		events: [] as Array<[string, any]>,
		status: new Map<string, string | undefined>(),
		writes: 0,
		timers: new Set<() => void>(),
		tick: () => [...f.timers].forEach((fn) => fn()),
		port: undefined as any,
	};
	const ui = { setStatus: (k: string, v?: string) => void (f.writes++, f.status.set(k, v)) };
	f.port = {
		send(m: any) {
			if (f.fail === "throw") throw new Error("send failed");
			if (f.fail === "reject") return Promise.reject(new Error("send rejected"));
			f.sent.push(m);
		},
		idle: () => f.idle,
		ui: () => (f.hasUI ? ui : undefined),
		emit: (e: string, p: any) => void f.events.push([e, p]),
		every(_ms: number, fn: () => void) {
			f.timers.add(fn);
			return () => void f.timers.delete(fn);
		},
	};
	return f;
}

describe("wake-up notifier", () => {
	const job = (o: Partial<Job> = {}): Job => ({ id: jobs.newId(), name: "j", status: "completed", startedAt: 0, completedAt: 1, notifyOnCompletion: true, resultObservedAt: null, notificationDeliveredAt: null, ...o });
	const msg = (j: Job) => () => ({ customType: "bg-notification" as const, content: `done ${j.id}`, display: false as const, details: { kind: "shell" as const, id: j.id, name: j.name, status: j.status } });
	const make = (o?: { idle?: boolean }) => {
		const f = fakePort(o);
		return { f, n: createNotifier(f.port, { pending: new Map() }) };
	};

	it("wakes an idle agent at once, and only once", () => {
		const { f, n } = make();
		const j = job();
		n.settled(j, msg(j));
		n.settled(j, msg(j));
		assert.equal(f.sent.length, 1);
		assert.ok(j.notificationDeliveredAt);
	});
	it("a failed send leaves the wake-up pending, unstamped", async () => {
		for (const fail of ["throw", "reject"] as const) {
			const { f, n } = make();
			f.fail = fail;
			const j = job();
			n.settled(j, msg(j));
			await new Promise((r) => setImmediate(r));
			assert.equal(j.notificationDeliveredAt, null, fail);
			f.fail = undefined;
			n.settle({ aborted: false });
			assert.equal(f.sent.length, 1, fail);
		}
	});
	it("while busy, appends at the turn boundary after other extensions' entries", () => {
		const { f, n } = make({ idle: false });
		const j = job();
		n.settled(j, msg(j));
		assert.equal(f.sent.length, 0);
		const theirs = { type: "custom", customType: "other", data: 1 };
		const r = n.boundary({ entries: [theirs] })!;
		assert.equal(r.continue, true);
		assert.deepEqual(r.entries[0], theirs);
		assert.equal((r.entries[1] as any).type, "custom_message");
		assert.match((r.entries[1] as any).content, new RegExp(j.id));
		assert.ok(j.notificationDeliveredAt);
		assert.equal(n.boundary({ entries: [theirs] }), undefined, "nothing of ours: leave the entries alone");
	});
	it("reading the result withdraws its wake-up; a live job is not read", () => {
		const { f, n } = make({ idle: false });
		const j = job();
		n.settled(j, msg(j));
		n.read(j);
		assert.ok(j.resultObservedAt);
		assert.equal(n.boundary({ entries: [] }), undefined);
		const running = job({ status: "running", completedAt: null });
		n.read(running);
		assert.equal(running.resultObservedAt, null);
		assert.equal(f.sent.length, 0);
	});
	it("holds pending wake-ups through an aborted run, sends them after a normal one", () => {
		const { f, n } = make({ idle: false });
		const j = job();
		n.settled(j, msg(j));
		n.settle({ aborted: true });
		assert.equal(f.sent.length, 0);
		n.settle({ aborted: false });
		assert.equal(f.sent.length, 1);
	});
	it("reports every change to what is read or delivered", async () => {
		const f = fakePort();
		let changes = 0;
		const n = createNotifier(f.port, { pending: new Map() }, () => changes++);
		const a = job();
		n.settled(a, msg(a)); // delivered
		assert.equal(changes, 1);
		f.fail = "reject";
		const b = job();
		n.settled(b, msg(b)); // delivered, then undone
		await new Promise((r) => setImmediate(r));
		assert.equal(changes, 3);
		n.read(b);
		assert.equal(changes, 4);
	});
	it("a send that fails after drop does not bring the wake-up back", async () => {
		const { f, n } = make();
		f.fail = "reject";
		const j = job();
		n.settled(j, msg(j));
		n.drop(); // session ends before the rejection lands
		await new Promise((r) => setImmediate(r));
		f.fail = undefined;
		n.settle({ aborted: false });
		assert.equal(f.sent.length, 0);
	});
	it("ignores jobs that are not due, and forgets everything on drop", () => {
		const { f, n } = make({ idle: false });
		const quiet = job({ notifyOnCompletion: false });
		n.settled(quiet, msg(quiet));
		const j = job();
		n.settled(j, msg(j));
		n.drop();
		n.settle({ aborted: false });
		assert.equal(f.sent.length, 0);
	});
});

describe("footer module", () => {
	const strip = (t?: string) => t?.replace(/\x1b\[[0-9;]*m/g, "");
	const make = (o?: { ui?: boolean }) => {
		const f = fakePort(o);
		const counts = { bg: { running: 0, failedUnread: 0 }, agents: { running: 0, failedUnread: 0 } };
		const state = { footer: new WeakMap<object, string>(), frame: 0 };
		return { f, counts, state, footer: createFooter(f.port, () => counts, state) };
	};

	it("opens as dim zeros through setStatus alone, and writes only on change", () => {
		const { f, footer } = make();
		footer.open();
		assert.equal(strip(f.status.get("bgtasks")), "\uf489 0  \uf1ae 0");
		assert.deepEqual(f.events, [], "no second channel");
		const writes = f.writes;
		footer.publish();
		assert.equal(f.writes, writes);
	});
	it("spins only while something runs, one frame per tick", () => {
		const { f, counts, footer } = make();
		footer.open();
		assert.equal(f.timers.size, 0);
		counts.agents.running = 1;
		footer.publish();
		assert.equal(f.timers.size, 1);
		assert.match(f.status.get("bgtasks")!, /\uf1ae 1⠋/);
		f.tick();
		assert.match(f.status.get("bgtasks")!, /\uf1ae 1⠙/);
		counts.agents.running = 0;
		f.tick();
		assert.equal(f.timers.size, 0);
		assert.equal(strip(f.status.get("bgtasks")), "\uf489 0  \uf1ae 0");
	});
	it("close removes the footer and stops the spinner; nothing repaints until open", () => {
		const { f, counts, footer } = make();
		counts.bg.running = 1;
		footer.open();
		footer.close();
		assert.equal(f.status.has("bgtasks"), true);
		assert.equal(f.status.get("bgtasks"), undefined);
		assert.equal(f.timers.size, 0);
		footer.publish();
		assert.equal(f.status.get("bgtasks"), undefined);
		footer.open();
		assert.match(f.status.get("bgtasks")!, /\uf489 1/);
	});
	it("open repaints even when the text has not changed (a /reload keeps the same UI)", () => {
		const { f, footer } = make();
		footer.open();
		const writes = f.writes;
		footer.open();
		assert.equal(f.writes, writes + 1);
	});
	it("only the instance that opened last drives the spinner", () => {
		const f = fakePort();
		const counts = { bg: { running: 0, failedUnread: 0 }, agents: { running: 0, failedUnread: 0 } };
		const state = { footer: new WeakMap<object, string>(), frame: 0 };
		const old = createFooter(f.port, () => counts, state);
		old.open();
		const next = createFooter(f.port, () => counts, state);
		next.open();
		counts.bg.running = 1;
		old.publish(); // a late callback from before the /reload
		assert.equal(f.timers.size, 0, "a stale instance never starts the spinner");
		next.publish();
		assert.equal(f.timers.size, 1);
	});
	it("without a UI, writes nothing and runs no spinner", () => {
		const { f, counts, footer } = make({ ui: false });
		counts.bg.running = 1;
		footer.open();
		assert.equal(f.writes, 0);
		assert.equal(f.timers.size, 0);
	});
	it("a new instance takes the spinner over at open (a /reload), not at load (a child session)", () => {
		const f = fakePort();
		const counts = { bg: { running: 1, failedUnread: 0 }, agents: { running: 0, failedUnread: 0 } };
		const state = { footer: new WeakMap<object, string>(), frame: 0 };
		createFooter(f.port, () => counts, state).open();
		const [old] = f.timers;
		const next = createFooter(f.port, () => counts, state);
		assert.ok(f.timers.has(old), "loading another instance leaves the spinner alone");
		next.open();
		assert.equal(f.timers.size, 1);
		assert.ok(!f.timers.has(old), "open stops the old interval and starts its own");
	});
});

describe("job ledger", () => {
	type Fake = Job;
	const stopped: string[] = [];
	const forgotten: string[] = [];
	const fake = jobs.lane<Fake>({
		name: "test",
		key: Symbol("test-lane"),
		events: { changed: "t:changed", terminal: "t:terminal", field: "job" },
		snapshot: (j) => ({ ...j }),
		summary: (j) => `${j.id} ${j.status}`,
		read: (j) => `read ${j.id}`,
		message: (j) => ({ customType: "bg-notification", content: `done ${j.id}`, display: false, details: { kind: "shell", id: j.id, name: j.name, status: j.status } }),
		stop: async (j) => void stopped.push(j.id),
		forget: (j) => void forgotten.push(j.id),
	});
	const job = (id = jobs.newId(), status: Status = "running"): Fake => ({ id, name: id, status, startedAt: Date.now(), completedAt: null, notifyOnCompletion: true, resultObservedAt: null, notificationDeliveredAt: null });
	function setup() {
		const pi = mockPi();
		const seen: Array<[string, any]> = [];
		(pi as any).events = { emit: (n: string, p: any) => void seen.push([n, p]) };
		backgroundExtension(pi as any);
		host.ctx = mockCtx(tmp());
		return { pi, seen };
	}
	afterEach(() => {
		fake.store.clear();
		stopped.length = forgotten.length = 0;
	});

	it("announces add, change and settle as v1 events, and wakes once", () => {
		const { pi, seen } = setup();
		const j = job();
		fake.add(j);
		fake.changed(j);
		fake.settle(j, "completed");
		fake.settle(j, "failed"); // the first settle wins
		assert.deepEqual(seen.map((e) => e[0]), ["t:changed", "t:changed", "t:changed", "t:terminal"]);
		assert.equal(seen.at(-1)![1].version, 1);
		assert.equal(seen.at(-1)![1].job.status, "completed");
		assert.equal(j.status, "completed");
		assert.equal(pi.sent.length, 1);
	});
	it("a kill records its intent: the job ends killed, never wakes, and counts as read", async () => {
		const { pi } = setup();
		const j = job();
		fake.add(j);
		await jobs.kill(j);
		assert.deepEqual(stopped, [j.id]);
		fake.settle(j, "completed"); // the work ends after the stop
		assert.equal(j.status, "killed");
		assert.equal(pi.sent.length, 0);
		assert.ok(j.resultObservedAt);
		await jobs.kill(j); // already finished: no second stop
		assert.deepEqual(stopped, [j.id]);
	});
	it("an unread failure counts until it is read", () => {
		setup();
		const j = { ...job(), notifyOnCompletion: false };
		fake.add(j);
		assert.deepEqual(jobs.count(fake.store.values()), { running: 1, failedUnread: 0 });
		fake.settle(j, "failed");
		assert.deepEqual(jobs.count(fake.store.values()), { running: 0, failedUnread: 1 });
		assert.equal(jobs.read(j), `read ${j.id}`);
		assert.deepEqual(jobs.count(fake.store.values()), { running: 0, failedUnread: 0 });
	});
	it("keeps the newest finished jobs, never prunes live work, and releases what it prunes", () => {
		setup();
		const live = job();
		const stopping = job(jobs.newId(), "killed"); // killed, work not ended yet
		fake.add(live);
		fake.add(stopping);
		const done: Fake[] = [];
		for (let i = 0; i < jobs.KEEP_FINISHED + 2; i++) {
			const j = { ...job(), notifyOnCompletion: false };
			fake.add(j);
			fake.settle(j, "completed");
			j.completedAt = i; // a strict order
			done.push(j);
		}
		fake.add({ ...job(), notifyOnCompletion: false });
		assert.deepEqual(forgotten, [done[0].id, done[1].id]);
		assert.ok(fake.store.has(live.id) && fake.store.has(stopping.id));
	});
	it("reading a job whose work has not ended yet does not count as read", () => {
		const { pi } = setup();
		const j = job();
		fake.add(j);
		j.status = "killed"; // a timeout: killed, still waking, the process not gone yet
		jobs.read(j);
		assert.equal(j.resultObservedAt, null);
		fake.settle(j, "killed");
		assert.equal(pi.sent.length, 1);
	});
	it("a kill is announced at once, before the work has stopped", async () => {
		const { seen } = setup();
		const j = job();
		fake.add(j);
		const pending = jobs.kill(j);
		assert.equal(seen.at(-1)![0], "t:changed");
		assert.equal(seen.at(-1)![1].job.status, "killed");
		assert.ok(j.resultObservedAt, "a kill counts as read from the moment it is recorded");
		assert.deepEqual(jobs.count(fake.store.values()), { running: 0, failedUnread: 0 });
		await pending;
	});
	it("finds by id or unique prefix across lanes", () => {
		setup();
		const a = job("abc123");
		fake.add(a);
		assert.equal(jobs.find("abc"), a);
		assert.equal(fake.get("abc123"), a);
		shell.tasks.set("abd999", { ...job("abd999"), command: "x", logPath: "/x" } as any);
		try {
			assert.throws(() => jobs.find("ab"), /Ambiguous/);
			assert.equal(jobs.find("abd").id, "abd999");
			assert.throws(() => jobs.find("zz"), /Unknown background task/);
			assert.throws(() => jobs.find(" "), /Missing taskId/);
			assert.throws(() => (globalThis as any)[shell.SERVICE_KEY].get("zz"), /Unknown/);
		} finally {
			shell.tasks.delete("abd999");
		}
	});
});

describe("run scheduler", () => {
	type J = { name: string };
	const make = (max = 2, foreign?: () => Iterable<{ job: J; done?: Promise<unknown> }>) => {
		const begun: string[] = [];
		const q = scheduler<J>({ key: Symbol("test-queue"), max, begin: (j) => void begun.push(j.name), foreign });
		return { q, begun };
	};
	const gate = () => {
		let open!: () => void;
		const p = new Promise<void>((r) => (open = r));
		return { p, open };
	};
	const tick = () => new Promise((r) => setImmediate(r));

	it("starts first in, first out, and holds a slot until the work settles", async () => {
		const { q, begun } = make(2);
		const gates = [gate(), gate(), gate()];
		const jobsIn = [{ name: "a" }, { name: "b" }, { name: "c" }];
		const done = jobsIn.map((j, i) => q.submit(j, () => gates[i].p));
		assert.deepEqual(begun, ["a", "b"]);
		assert.deepEqual(q.waiting(), [jobsIn[2]]);
		gates[1].open();
		await done[1];
		await tick();
		assert.deepEqual(begun, ["a", "b", "c"]);
		gates[0].open();
		gates[2].open();
		await Promise.all(done);
	});
	it("withdraws waiting work without starting it", async () => {
		const { q, begun } = make(1);
		const g = gate();
		const a = q.submit({ name: "a" }, () => g.p);
		const b = { name: "b" };
		const bDone = q.submit(b, async () => assert.fail("withdrawn work started"));
		assert.equal(q.withdraw(b), true);
		await bDone;
		assert.equal(q.withdraw(b), false);
		g.open();
		await a;
		await tick();
		assert.deepEqual(begun, ["a"]);
	});
	it("work that throws or rejects releases its slot", async () => {
		const { q, begun } = make(1);
		await q.submit({ name: "sync" }, () => {
			throw new Error("x");
		});
		await q.submit({ name: "async" }, async () => {
			throw new Error("y");
		});
		await q.submit({ name: "next" }, async () => {});
		assert.deepEqual(begun, ["sync", "async", "next"]);
	});
	it("foreign work holds slots: with a promise until it settles, without one while listed", async () => {
		const held = gate();
		const listed = [{ job: { name: "restored" }, done: held.p as Promise<unknown> | undefined }, { job: { name: "building" } }];
		const { q, begun } = make(3, () => listed);
		const g = gate();
		const a = q.submit({ name: "a" }, () => g.p);
		const b = q.submit({ name: "b" }, async () => {});
		assert.deepEqual(begun, ["a"]);
		q.setLimit(3); // reconciling again must not double-count
		assert.deepEqual(begun, ["a"]);
		listed.splice(0); // both foreign runs end; only the promise wakes the queue
		held.open();
		await b;
		assert.deepEqual(begun, ["a", "b"]);
		g.open();
		await a;
	});
	it("a foreign job still listed after its promise settled is not adopted again", async () => {
		const stale = { job: { name: "stale" }, done: Promise.resolve() };
		const { q, begun } = make(1, () => [stale]);
		const a = q.submit({ name: "a" }, async () => {});
		await a;
		await q.submit({ name: "b" }, async () => {});
		assert.deepEqual(begun, ["a", "b"]);
	});
	it("rejects a limit outside 1..max", () => {
		const { q } = make(2);
		assert.throws(() => q.setLimit(3), /Invalid concurrency/);
		assert.throws(() => q.setLimit(0), /Invalid concurrency/);
	});
});

describe("declarations", () => {
	const ok = "---\ndescription: Reads code\ntools: read, grep\nmodel: p/m\n---\nYou read.";
	it("parses a complete declaration", () => {
		const d = agents.parseDeclaration("reader", ok) as agents.Declaration;
		assert.deepEqual(d.tools, ["read", "grep"]);
		assert.equal(d.maxTurns, agents.DEFAULT_MAX_TURNS);
		assert.equal(d.systemPrompt, "You read.");
	});
	for (const [why, text, name] of [
		["missing model", ok.replace("model: p/m\n", ""), "a"],
		["missing tools", ok.replace("tools: read, grep\n", ""), "a"],
		["empty prompt", ok.replace("You read.", ""), "a"],
		["unknown key", ok.replace("---\nYou", "extra: 1\n---\nYou"), "a"],
		["bad model", ok.replace("p/m", "two words"), "a"],
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
	it("bg_kill on a finished task says so instead of claiming to stop it", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp());
		const t = shell.start(ctx, { command: "true", notifyOnCompletion: false });
		await until(() => t.completedAt !== null);
		const res = await pi.tools.get("bg_kill").execute("k", { taskId: t.id }, undefined, undefined, ctx);
		assert.match(res.content[0].text, /already completed/);
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
	const decl: agents.Declaration = { name: "reader", description: "d", tools: ["read"], model: "p/m", maxTurns: 2, systemPrompt: "p" };
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
	it("background with notifyOnCompletion: false never wakes; the report waits in bg_logs", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp(), { idle: true });
		await pi.fire("session_start", {}, ctx);
		use(fakeSession(() => {}));
		const r = await agents.spawn(ctx, decl, { prompt: "go", background: true, notifyOnCompletion: false });
		await r.done;
		assert.equal(pi.sent.length, 0);
		assert.equal(await pi.fire("turn_end", {}, ctx), undefined);
		assert.match(agents.report(r), /COMPLETED, UNREAD/);
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
		await jobs.kill(r);
		assert.equal(r.status, "killed");
		assert.equal(pi.sent.length, 0);
	});
	it("queues FIFO, starts once, cancels queued work, and preserves wakes", async () => {
		agents.queue.setLimit(1);
		const pi = mockPi();
		backgroundExtension(pi as any);
		const started: string[] = [];
		const release: Array<() => void> = [];
		agents.setFactory({ create: async () => {
			const s: any = fakeSession(() => {});
			s.prompt = async (text: string) => {
				started.push(text);
				await new Promise<void>(resolve => release.push(resolve));
			};
			s.abort = async () => { release.shift()?.(); };
			return s;
		}});
		const ctx = mockCtx(tmp());
		const spawn = (prompt: string) => agents.spawn(ctx, decl, { prompt, background: true });
		try {
			const a = await spawn("a");
			const b = await spawn("b");
			const cancelled = await spawn("cancelled");
			const c = await spawn("c");
			assert.equal(b.status, "queued");
			assert.equal(c.status, "queued");
			jobs.observe(b);
			assert.equal(b.resultObservedAt, null);
			await jobs.kill(cancelled);
			await cancelled.done;
			assert.equal(cancelled.status, "killed");
			const controller = new AbortController();
			const aborted = await agents.spawn(ctx, decl, { prompt: "aborted", background: false, signal: controller.signal });
			controller.abort();
			await aborted.done;
			assert.equal(aborted.status, "killed");
			assert.deepEqual(started, ["a"]);
			release.shift()!();
			await a.done;
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(started, ["a", "b"]);
			release.shift()!();
			await b.done;
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(started, ["a", "b", "c"]);
			release.shift()!();
			await c.done;
			assert.equal(pi.sent.length, 3);
		} finally {
			await jobs.killAll();
			agents.queue.setLimit();
		}
	});
	it("counts pre-existing running work before pumping and starts the fifth once", async () => {
		agents.queue.setLimit();
		const releases: Array<() => void> = [];
		const seeded: agents.AgentRun[] = [];
		for (let i = 0; i < 2; i++) {
			const r = { id: `restored-${i}`, status: "running", startedAt: Date.now(),
				done: new Promise<void>(resolve => releases.push(resolve)) } as agents.AgentRun;
			agents.runs.set(r.id, r);
			seeded.push(r);
		}
		const started: string[] = [];
		const finish: Array<() => void> = [];
		agents.setFactory({ create: async () => {
			const s: agents.ChildSession = fakeSession(() => {});
			s.prompt = async (text: string) => {
				started.push(text);
				await new Promise<void>(resolve => finish.push(resolve));
			};
			s.abort = async () => { finish.shift()?.(); };
			return s;
		}});
		try {
			const ctx = mockCtx(tmp());
			const a = await agents.spawn(ctx, decl, { prompt: "third", background: false });
			const b = await agents.spawn(ctx, decl, { prompt: "fourth", background: false });
			const c = await agents.spawn(ctx, decl, { prompt: "fifth", background: false });
			assert.equal(c.status, "queued");
			assert.deepEqual(started, ["third", "fourth"]);
			agents.queue.setLimit(); // repeated reconciliation must not double-count or start
			seeded[0].status = "completed";
			releases[0]();
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(started, ["third", "fourth", "fifth"]);
			seeded[1].status = "completed";
			releases[1]();
			agents.queue.setLimit();
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(started, ["third", "fourth", "fifth"]);
			finish.splice(0).forEach(resolve => resolve());
			await Promise.all([a.done, b.done, c.done]);
		} finally {
			seeded.forEach((r, i) => { r.status = "completed"; releases[i](); agents.runs.delete(r.id); });
			await jobs.killAll();
		}
	});
	it("creation failure finishes and releases the slot", async () => {
		agents.setFactory({ create: async () => { throw new Error("nope"); } });
		const r = await agents.spawn(mockCtx(tmp()), decl, { prompt: "go", background: false });
		await r.done;
		assert.equal(r.status, "failed");
		assert.match(r.error!, /nope/);
		assert.equal(agents.running().length, 0);
	});
	it("rejects overflow without starting extra work and admits a replacement after cancellation", async () => {
		agents.queue.setLimit(1);
		const started: string[] = [];
		let release!: () => void;
		agents.setFactory({
			create: async () => {
				const s: any = fakeSession(() => new Promise<void>((resolve) => (release = resolve)));
				s.prompt = async (text: string) => {
					started.push(text);
					await new Promise<void>((resolve) => (release = resolve));
				};
				s.abort = async () => release?.();
				return s;
			},
		});
		try {
			const ctx = mockCtx(tmp());
			await agents.spawn(ctx, decl, { prompt: "active", background: true });
			const queued: agents.AgentRun[] = [];
			for (let i = 0; i < agents.MAX_QUEUED; i++) {
				queued.push(await agents.spawn(ctx, decl, { prompt: `queued-${i}`, background: true }));
			}
			await assert.rejects(agents.spawn(ctx, decl, { prompt: "overflow", background: true }), /queue full/);
			assert.deepEqual(started, ["active"]);
			await jobs.kill(queued[0]!);
			await agents.spawn(ctx, decl, { prompt: "replacement", background: true });
			assert.deepEqual(started, ["active"]);
		} finally {
			await jobs.killAll();
			agents.queue.setLimit();
		}
	});

	it("promotes queued work after a creation failure and preserves both notifications", async () => {
		agents.queue.setLimit(1);
		const pi = mockPi();
		backgroundExtension(pi as any);
		const started: string[] = [];
		agents.setFactory({
			create: async (_ctx, _d, _model) => {
				const attempt = started.length;
				started.push(attempt === 0 ? "first" : "second");
				if (attempt === 0) throw new Error("creation failed");
				return fakeSession(() => {});
			},
		});
		try {
			const ctx = mockCtx(tmp());
			const first = await agents.spawn(ctx, decl, { prompt: "first", background: true });
			const second = await agents.spawn(ctx, decl, { prompt: "second", background: true });
			await Promise.all([first.done, second.done]);
			assert.deepEqual(started, ["first", "second"]);
			assert.equal(first.status, "failed");
			assert.match(first.error!, /creation failed/);
			assert.equal(second.status, "completed");
			assert.equal(pi.sent.length, 2);
		} finally {
			await jobs.killAll();
			agents.queue.setLimit();
		}
	});

	it("waits for a foreground queued run and returns its result", async () => {
		agents.queue.setLimit(1);
		const releases: Array<() => void> = [];
		agents.setFactory({
			create: async () => {
				const s: any = fakeSession(() => {});
				s.prompt = async () => new Promise<void>((resolve) => releases.push(resolve));
				s.abort = async () => releases.shift()?.();
				return s;
			},
		});
		try {
			const ctx = mockCtx(tmp());
			const first = await agents.spawn(ctx, decl, { prompt: "first", background: true });
			const foreground = await agents.spawn(ctx, decl, { prompt: "foreground", background: false });
			assert.equal(foreground.status, "queued");
			releases.shift()!();
			await first.done;
			await until(() => foreground.status === "running");
			releases.shift()!();
			await foreground.done;
			assert.equal(foreground.status, "completed");
			assert.equal(foreground.result, "answer");
		} finally {
			await jobs.killAll();
			agents.queue.setLimit();
		}
	});

	it("killAll cancels queued and running work without starting or waking it", async () => {
		agents.queue.setLimit(1);
		const pi = mockPi();
		backgroundExtension(pi as any);
		const started: string[] = [];
		let release!: () => void;
		agents.setFactory({
			create: async () => {
				const s: any = fakeSession(() => new Promise<void>((resolve) => (release = resolve)));
				s.prompt = async (text: string) => {
					started.push(text);
					await new Promise<void>((resolve) => (release = resolve));
				};
				s.abort = async () => release?.();
				return s;
			},
		});
		try {
			const ctx = mockCtx(tmp());
			const active = await agents.spawn(ctx, decl, { prompt: "active", background: true });
			const queued = await agents.spawn(ctx, decl, { prompt: "queued", background: true });
			await jobs.killAll();
			assert.equal(active.status, "killed");
			assert.equal(queued.status, "killed");
			assert.deepEqual(started, ["active"]);
			assert.equal(pi.sent.length, 0);
		} finally {
			agents.queue.setLimit();
		}
	});

	it("refuses a model that does not exist", async () => {
		await assert.rejects(agents.spawn(mockCtx(tmp()), { ...decl, model: "x/y" }, { prompt: "go", background: false }), /does not exist/);
	});
});

describe("results the caller can trust", () => {
	const decl: agents.Declaration = { name: "reader", description: "d", tools: ["read"], model: "p/m", maxTurns: 5, systemPrompt: "p" };
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
		const res = await call(pi, ctx, { agent: "scout", model: "p/m" });
		assert.deepEqual(created[0].tools, agents.SAFE_TOOLS);
		assert.equal(created[0].model, "p/m");
		const file = join(dir, "agents", "scout.md");
		assert.ok(existsSync(file));
		assert.match(res.content[0].text, /was not declared[\s\S]*created at .*scout\.md/);
		// now a normal declaration: reused, not overwritten, no second note
		writeFileSync(file, readFileSync(file, "utf8").replace("Auto-created", "Edited"));
		const again = await call(pi, ctx, { agent: "scout" });
		assert.doesNotMatch(again.content[0].text, /was not declared/);
		assert.match(readFileSync(file, "utf8"), /Edited/);
	});
	it("requires a model to create an agent and never inherits one", async () => {
		const { dir, pi, ctx } = setup();
		await assert.rejects(call(pi, ctx, { agent: "scout" }), /pass model \(provider\/id or model id\)\. Available: p\/m/);
		await assert.rejects(call(pi, ctx, { agent: "scout", model: "inherit" }), /Cannot create agent/);
		assert.equal(existsSync(join(dir, "agents")), false);
	});
	it("does not save a default whose model is unusable", async () => {
		const { dir, pi, ctx } = setup();
		await assert.rejects(call(pi, ctx, { agent: "ghost", model: "x/y" }), /does not exist/);
		assert.equal(existsSync(join(dir, "agents", "ghost.md")), false);
	});
	it("rejects bad names and models without writing", async () => {
		const { dir, pi, ctx } = setup();
		await assert.rejects(call(pi, ctx, { agent: "../evil", model: "p/m" }), /Cannot create agent/);
		await assert.rejects(call(pi, ctx, { agent: "ok", model: "not a model" }), /Cannot create agent/);
		assert.equal(existsSync(join(dir, "agents")), false);
	});
	it("refuses to replace an invalid declaration, and a model override on a declared agent", async () => {
		const { dir, pi, ctx } = setup();
		mkdirSync(join(dir, "agents"));
		writeFileSync(join(dir, "agents", "broken.md"), "nope");
		await assert.rejects(call(pi, ctx, { agent: "broken" }), /invalid declaration/);
		assert.equal(readFileSync(join(dir, "agents", "broken.md"), "utf8"), "nope");
		await call(pi, ctx, { agent: "fine", model: "p/m" });
		await assert.rejects(call(pi, ctx, { agent: "fine", model: "a/b" }), /only applies to a new agent/);
	});
});

describe("provider choice", () => {
	function ctxWith(models: Array<[string, string, number]>) {
		const all = models.map(([provider, id]) => ({ provider, id }));
		const tier = new Map(models.map(([p, , t]) => [p, t]));
		return {
			modelRegistry: {
				find: (p: string, i: string) => all.find((m) => m.provider === p && m.id === i),
				getAll: () => all,
				getAvailable: () => all.filter(() => true),
				isUsingOAuth: (m: any) => (tier.get(m.provider) ?? 0) >= 1,
				runtime: { isUsingSubscription: (p: string) => tier.get(p) === 2 },
			},
		} as any;
	}
	const d = (model: string): agents.Declaration => ({ name: "a", description: "d", tools: [], model, maxTurns: 1, systemPrompt: "p" });

	it("a bare id prefers the subscription provider", () => {
		const ctx = ctxWith([["api", "m", 0], ["sub", "m", 2], ["oauth", "m", 1]]);
		assert.equal(agents.resolveModel(ctx, d("m")).label, "sub/m");
	});
	it("OAuth beats API key when the runtime hides subscription data", () => {
		const ctx = ctxWith([["api", "m", 0], ["oauth", "m", 1]]);
		assert.equal(agents.resolveModel(ctx, d("m")).label, "oauth/m");
	});
	it("provider/id is never swapped", () => {
		const ctx = ctxWith([["api", "m", 0], ["sub", "m", 2]]);
		assert.equal(agents.resolveModel(ctx, d("api/m")).label, "api/m");
	});
	it("a tie at the best tier is an error, not a guess", () => {
		const ctx = ctxWith([["a", "m", 0], ["b", "m", 0]]);
		assert.throws(() => agents.resolveModel(ctx, d("m")), /ambiguous \(a\/m, b\/m\)/);
	});
	it("a single provider works; an unknown id fails", () => {
		const ctx = ctxWith([["api", "m", 0]]);
		assert.equal(agents.resolveModel(ctx, d("m")).label, "api/m");
		assert.throws(() => agents.resolveModel(ctx, d("zzz")), /does not exist/);
	});
	it("a bare id with a subscription lacking credentials falls to what is usable", () => {
		const ctx = ctxWith([["api", "m", 0], ["sub", "m", 2]]);
		ctx.modelRegistry.getAvailable = () => [{ provider: "api", id: "m" }];
		assert.equal(agents.resolveModel(ctx, d("m")).label, "api/m");
	});
});

describe("footer", () => {
	it("shows dim placeholders from session start, counts while running, and clears at shutdown", async () => {
		const strip = (t?: string) => t?.replace(/\x1b\[[0-9;]*m/g, "");
		shell.tasks.clear();
		agents.runs.clear();
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp(), { ui: true });
		await pi.fire("session_start", {}, ctx);
		assert.equal(strip(ctx.status.bgtasks), "\uf489 0  \uf1ae 0", "one key carries both lanes");
		assert.equal(ctx.status["bg-agents"], undefined, "no second key to place");
		const t = shell.start(ctx, { command: "sleep 30", name: "a\x1b[31m\nb", notifyOnCompletion: false });
		assert.match(ctx.status.bgtasks!, /\uf489 1⠋/);
		await jobs.kill(t);
		await until(() => strip(ctx.status.bgtasks) === "\uf489 0  \uf1ae 0");
		assert.ok(!/[\x00-\x1f]/.test(t.name));
		await pi.fire("session_shutdown", { reason: "exit" }, ctx);
		assert.equal(ctx.status.bgtasks, undefined);
	});
	it("counts running jobs only; colour carries the state; an unread failure turns the lane red until read", async () => {
		const strip = (t?: string) => t?.replace(/\x1b\[[0-9;]*m/g, "");
		assert.equal(strip(label({ running: 2, failedUnread: 0 }, "T", 45)), "T 2⠋");
		assert.equal(strip(label({ running: 2, failedUnread: 0 }, "T", 45, 3)), "T 2⠸");
		assert.match(label({ running: 2, failedUnread: 0 }, "T", 45), /38;5;45m/, "running: lane colour");
		assert.equal(strip(label({ running: 0, failedUnread: 0 }, "T", 45)), "T 0");
		assert.match(label({ running: 0, failedUnread: 0 }, "T", 45), /38;5;240m/, "idle: dim");
		assert.equal(strip(label({ running: 1, failedUnread: 2 }, "A", 141)), "\uf071 1⠋", "failures swap the glyph, not the count");
		assert.match(label({ running: 1, failedUnread: 2 }, "A", 141), /38;5;203m/, "unread failure: red");
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp(), { ui: true });
		await pi.fire("session_start", {}, ctx);
		const t = shell.start(ctx, { command: "exit 3", notifyOnCompletion: false });
		await until(() => t.status === "failed");
		assert.match(ctx.status.bgtasks!, /38;5;203m\uf071 0/);
		assert.deepEqual(jobs.count(shell.tasks.values()), { running: 0, failedUnread: 1 });
		await pi.tools.get("bg_logs").execute("c", { taskId: t.id }, undefined, undefined, ctx);
		assert.match(ctx.status.bgtasks!, /38;5;240m\uf489 0/);
	});
	it("a failure delivered as a wake-up clears the red, idle or at a turn boundary", async () => {
		for (const idle of [true, false]) {
			const pi = mockPi();
			backgroundExtension(pi as any);
			const ctx = mockCtx(tmp(), { ui: true, idle });
			await pi.fire("session_start", {}, ctx);
			const t = shell.start(ctx, { command: "exit 3" });
			await until(() => t.completedAt !== null);
			if (!idle) {
				assert.match(ctx.status.bgtasks!, /38;5;203m/, "red while the failure waits");
				await pi.fire("turn_end", { entries: [] }, ctx);
			}
			assert.ok(t.notificationDeliveredAt, `delivered (idle: ${idle})`);
			assert.doesNotMatch(ctx.status.bgtasks!, /38;5;203m/, `not red once delivered (idle: ${idle})`);
			await pi.fire("session_shutdown", { reason: "exit" }, ctx);
		}
	});
	it("never puts a card in the transcript: every notification is display: false", async () => {
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp(), { idle: true });
		await pi.fire("session_start", {}, ctx);
		const t = shell.start(ctx, { command: "true" });
		await until(() => pi.sent.length === 1);
		assert.equal(pi.sent[0].m.display, false);
		assert.equal(t.notificationDeliveredAt !== null, true);
	});
	it("does not install inside a child session", async () => {
		const g = globalThis as any;
		g[agents.CHILD_KEY] = 1;
		try {
			const pi = mockPi();
			backgroundExtension(pi as any);
			assert.equal(pi.tools.size, 0);
			assert.notEqual(host.pi, pi);
		} finally {
			g[agents.CHILD_KEY] = 0;
		}
	});
	it("publishes no zentui custom variable: setStatus is the only footer channel", async () => {
		const pi = mockPi();
		const seen: string[] = [];
		(pi as any).events = { emit: (name: string) => void seen.push(name) };
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp(), { ui: true });
		await pi.fire("session_start", {}, ctx);
		const t = shell.start(ctx, { command: "sleep 30", notifyOnCompletion: false });
		assert.match(ctx.status.bgtasks!, /\uf489 1⠋/);
		await jobs.kill(t);
		await until(() => /38;5;240m/.test(ctx.status.bgtasks ?? ""));
		assert.ok(!seen.includes("zentui:variable"));
	});
	it("a foreground failure the model already received does not leave the footer red", async () => {
		const dir = tmp();
		process.env.PI_CODING_AGENT_DIR = dir;
		mkdirSync(join(dir, "agents"));
		writeFileSync(join(dir, "agents", "r.md"), "---\ndescription: d\ntools: read\nmodel: p/m\n---\nYou read.");
		const pi = mockPi();
		backgroundExtension(pi as any);
		const ctx = mockCtx(tmp(), { ui: true });
		await pi.fire("session_start", {}, ctx);
		agents.setFactory({
			create: async () => ({
				subscribe: (f: any) => (queueMicrotask(() => f({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } })), () => {}),
				prompt: async () => new Promise<void>((r) => setTimeout(r, 5)),
				abort: async () => {},
				dispose: () => {},
				getLastAssistantText: () => "",
				bindExtensions: async () => {},
			}),
		});
		await assert.rejects(pi.tools.get("subagent").execute("1", { agent: "r", prompt: "go" }, undefined, undefined, ctx), /FAILED: boom/);
		assert.doesNotMatch(ctx.status.bgtasks!, /38;5;203m/);
	});
	it("oneLine strips control characters", () => assert.equal(oneLine("a\x1b]0;x\x07\nb"), "a ]0;x b"));
});
