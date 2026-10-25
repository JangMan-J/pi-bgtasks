import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emit, host, notification, publish, taken, terminal } from "./host.ts";
import { duration, newId, oneLine, readTail, stateLabel, type Status } from "./kit.ts";

// Wire protocol v1: other extensions read these without importing this package.
export const TASKS_KEY = Symbol.for("jang.pi.bg.tasks.v1");
export const SERVICE_KEY = Symbol.for("jang.pi.bg.service.v1");
export const CHANGED = "bg-tasks:changed";
export const TERMINAL = "bg-tasks:terminal";

export const MAX_RUNNING = 16;
const KEEP_FINISHED = 32;
const KILL_GRACE_MS = 1500;

export interface ShellTask {
	id: string;
	name: string;
	command: string;
	cwd: string;
	pid: number | undefined;
	status: Status;
	exitCode: number | null;
	signal: string | null;
	startedAt: number;
	completedAt: number | null;
	logPath: string;
	notifyOnCompletion: boolean;
	resultObservedAt: number | null;
	notificationDeliveredAt: number | null;
	proc?: ChildProcess;
	timer?: ReturnType<typeof setTimeout>;
}
export type ShellSnapshot = Omit<ShellTask, "proc" | "timer">;

const g = globalThis as Record<symbol, any>;
export const tasks: Map<string, ShellTask> = (g[TASKS_KEY] ??= new Map());
host.stores.add(tasks);
const snap = ({ proc: _p, timer: _t, ...rest }: ShellTask): ShellSnapshot => ({ ...rest });
g[SERVICE_KEY] = {
	version: 1,
	store: tasks,
	list: () => [...tasks.values()].map(snap),
	get: (id: string) => {
		const t = tasks.get(id) ?? [...tasks.values()].find((x) => x.id.startsWith(id));
		if (!t) throw new Error(`Unknown background task "${id}"`);
		return snap(t);
	},
};

export const running = () => [...tasks.values()].filter((t) => t.status === "running");

function logDir(): string {
	const dir = process.env.PI_BG_LOG_DIR?.trim() || join(tmpdir(), `pi-bg-tasks-${process.getuid?.() ?? "u"}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Refuse a directory someone else planted: symlink or foreign owner.
	const st = lstatSync(dir);
	if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
		throw new Error(`Unsafe log directory ${dir}`);
	}
	return dir;
}

function signal(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pid, sig);
	} catch {
		try {
			process.kill(pid, sig);
		} catch {
			// already gone
		}
	}
}

/** SIGTERM the process group; SIGKILL after a grace period. Resolves when it exits. */
export function killGroup(t: ShellTask): Promise<void> {
	const { proc, pid } = t;
	if (!pid || !proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const hard = setTimeout(() => {
			signal(pid, "SIGKILL");
			resolve();
		}, KILL_GRACE_MS);
		proc.once("close", () => {
			clearTimeout(hard);
			resolve();
		});
		signal(pid, "SIGTERM");
	});
}

// Detached groups outlive pi if it dies without shutdown hooks; kill them on exit.
if (!g[Symbol.for("jang.pi.bg.exit.v1")]) {
	g[Symbol.for("jang.pi.bg.exit.v1")] = true;
	process.once("exit", () => {
		for (const t of running()) if (t.pid) signal(t.pid, "SIGKILL");
	});
}

export function summary(t: ShellTask | ShellSnapshot): string {
	const took = duration((t.completedAt ?? Date.now()) - t.startedAt);
	const how = t.status === "running" ? `PID ${t.pid ?? "?"}` : t.signal ? `signal ${t.signal}` : `exit ${t.exitCode ?? "?"}`;
	return `${t.id}  [${stateLabel(t)}]  ${t.name} (${how}, ${took})\n    cmd: ${oneLine(t.command, 200)}\n    log: ${t.logPath}`;
}

function message(t: ShellTask) {
	const tail = readTail(t.logPath, 4096, 40);
	return {
		customType: "bg-notification" as const,
		content: notification(
			"background-task-notification",
			{
				"task-id": t.id,
				name: oneLine(t.name),
				status: t.status,
				"exit-code": t.exitCode,
				duration: duration((t.completedAt ?? Date.now()) - t.startedAt),
				"log-path": t.logPath,
			},
			"output-tail",
			tail.text,
			tail.truncated,
		),
		display: false as const,
		details: { kind: "shell" as const, id: t.id, name: oneLine(t.name), status: t.status },
	};
}

function finish(t: ShellTask, code: number | null, sig: NodeJS.Signals | null): void {
	if (t.completedAt) return; // 'error' and 'close' can both fire
	clearTimeout(t.timer);
	t.timer = undefined;
	t.completedAt = Date.now();
	t.exitCode = code;
	t.signal = sig;
	if (t.status === "running") t.status = code === 0 ? "completed" : "failed";
	publish();
	emit(CHANGED, { version: 1, task: snap(t) });
	emit(TERMINAL, { version: 1, task: snap(t) });
	terminal(t, () => message(t));
}

function prune(): void {
	const done = [...tasks.values()].filter((t) => t.status !== "running").sort((a, b) => a.completedAt! - b.completedAt!);
	for (const t of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) {
		tasks.delete(t.id);
		rmSync(t.logPath, { force: true });
	}
}

export interface StartOptions {
	command: string;
	name?: string;
	cwd?: string;
	timeoutSeconds?: number;
	notifyOnCompletion?: boolean;
}

export function start(ctx: ExtensionContext, o: StartOptions): ShellTask {
	const command = o.command?.trim();
	if (!command) throw new Error("command is empty");
	if (running().length >= MAX_RUNNING) throw new Error(`Too many running background tasks (max ${MAX_RUNNING}). Kill one first.`);
	const cwd = o.cwd?.trim() || ctx.cwd;
	if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
	if (o.timeoutSeconds !== undefined && !(Number.isFinite(o.timeoutSeconds) && o.timeoutSeconds > 0)) {
		throw new Error("timeoutSeconds must be a positive number");
	}

	prune();
	const id = newId(taken);
	const logPath = join(logDir(), `${id}.log`);
	const fd = openSync(logPath, "a", 0o600);
	let proc: ChildProcess;
	try {
		proc = spawn("bash", ["-lc", command], { cwd, detached: true, stdio: ["ignore", fd, fd] });
	} finally {
		closeSync(fd);
	}

	const t: ShellTask = {
		id,
		name: oneLine(o.name ?? "") || oneLine(command, 40),
		command,
		cwd,
		pid: proc.pid,
		status: "running",
		exitCode: null,
		signal: null,
		startedAt: Date.now(),
		completedAt: null,
		logPath,
		notifyOnCompletion: o.notifyOnCompletion ?? true,
		resultObservedAt: null,
		notificationDeliveredAt: null,
		proc,
	};
	if (o.timeoutSeconds) {
		t.timer = setTimeout(() => {
			if (t.status !== "running") return;
			t.status = "killed";
			void killGroup(t);
		}, o.timeoutSeconds * 1000);
		t.timer.unref();
	}
	// Without an 'error' listener a failed spawn (ENOENT, EACCES) crashes pi.
	proc.once("error", (e) => {
		try {
			appendFileSync(logPath, `spawn failed: ${e.message}\n`);
		} catch {
			// log unavailable
		}
		finish(t, null, null);
	});
	proc.once("close", (code, sig) => finish(t, code, sig));

	tasks.set(id, t);
	publish();
	emit(CHANGED, { version: 1, task: snap(t) });
	return t;
}

/** User/agent-requested stop: no wake-up, result counts as seen. */
export async function kill(t: ShellTask): Promise<void> {
	if (t.status === "running") {
		t.status = "killed";
		t.notifyOnCompletion = false;
		await killGroup(t);
	}
	t.resultObservedAt ??= Date.now();
	publish();
}

export async function killAll(): Promise<void> {
	await Promise.all(running().map(kill));
}
