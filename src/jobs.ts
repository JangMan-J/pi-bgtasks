/**
 * The job ledger: one lifecycle for every background job, whatever runs it.
 *
 * A lane (shell tasks, subagent runs) supplies only what differs: how its work
 * is stopped, and how a job is shown. The ledger owns the rest: the published
 * v1 store and its events, ids unique across lanes, the status transitions,
 * the read and delivered stamps, the wake-up hand-off, footer counts, and
 * pruning.
 *
 *   add (queued | running) → changed* → settle (completed | failed | killed)
 *   → read with bg_logs, or delivered as a wake-up
 *
 * A kill records its intent before the lane stops the work, so a killed job
 * always ends "killed", never wakes, and counts as read.
 */
import type { Counts } from "./footer.ts";
import { emit, footer, notifier } from "./host.ts";
import type { Message } from "./notifier.ts";
import { live, newId as freshId, resolveId, unread, type Job, type Status } from "./kit.ts";

/** Finished jobs kept per lane; older ones are pruned when a new job is added. */
export const KEEP_FINISHED = 32;

export interface ReadOptions {
	tailLines?: number;
	maxBytes?: number;
}

export interface LaneSpec<J extends Job> {
	/** Footer lane: "bg" (shell tasks) or "agents". Other names are not counted in the footer. */
	name: string;
	/** globalThis key of the published v1 store (`Map<id, job>`), shared across /reload. */
	key: symbol;
	/** v1 event names, and the payload field that carries the snapshot. */
	events: { changed: string; terminal: string; field: string };
	/** The job without live handles (process, session, timers): what events and readers get. */
	snapshot(j: J): object;
	/** One entry of the bg_logs list. */
	summary(j: J): string;
	/** bg_logs output for one job. */
	read(j: J, o: ReadOptions): string;
	/** The wake-up for a settled job. */
	message(j: J): Message;
	/** Stop in-flight work. Resolves once stopped or given up; the lane settles the job when the work ends. */
	stop(j: J): Promise<void>;
	/** Release what a pruned job holds, such as its log file. */
	forget?(j: J): void;
}

export interface Lane<J extends Job> {
	readonly store: Map<string, J>;
	/** Register a new queued or running job. */
	add(j: J): void;
	/** Status or progress changed. */
	changed(j: J): void;
	/** The work ended. The first call wins, and a recorded kill keeps "killed". */
	settle(j: J, status: Exclude<Status, "queued" | "running">): void;
	/** Exact id or unique prefix within this lane. Throws when unknown or ambiguous. */
	get(id: string): J;
	running(): J[];
}

type Any = { spec: LaneSpec<any>; store: Map<string, Job>; changed(j: Job): void };
const lanes: Any[] = [];

export function lane<J extends Job>(spec: LaneSpec<J>): Lane<J> {
	const g = globalThis as Record<symbol, any>;
	const store: Map<string, J> = (g[spec.key] ??= new Map());
	const announce = (j: J, event: string) => emit(event, { version: 1, [spec.events.field]: spec.snapshot(j) });
	const changed = (j: J) => {
		footer.publish();
		announce(j, spec.events.changed);
	};
	lanes.push({ spec, store, changed: changed as (j: Job) => void });

	function prune(): void {
		const done = [...store.values()].filter((j) => !live(j) && j.completedAt !== null).sort((a, b) => a.completedAt! - b.completedAt!);
		for (const j of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) {
			store.delete(j.id);
			spec.forget?.(j);
		}
	}

	return {
		store,
		add(j) {
			prune();
			store.set(j.id, j);
			changed(j);
		},
		changed,
		settle(j, status) {
			if (j.completedAt) return;
			if (live(j)) j.status = status;
			j.completedAt = Date.now();
			footer.publish();
			announce(j, spec.events.changed);
			announce(j, spec.events.terminal);
			notifier.settled(j, () => spec.message(j));
		},
		get(id) {
			const j = resolveId(store, id);
			if (!j) throw new Error(`Unknown background task "${id}"`);
			return j;
		},
		running: () => [...store.values()].filter((j) => j.status === "running"),
	};
}

function laneOf(j: Job): Any {
	const l = lanes.find((x) => x.store.get(j.id) === j);
	if (!l) throw new Error(`Background task "${j.id}" is no longer tracked`);
	return l;
}

/** A fresh id, unique across every lane. */
export const newId = () => freshId((id) => lanes.some((l) => l.store.has(id)));

/** Exact id or unique prefix across every lane. */
export function find(id: string | undefined): Job {
	if (!id?.trim()) throw new Error("Missing taskId");
	const hits = lanes.map((l) => resolveId(l.store, id)).filter((j): j is Job => !!j);
	if (hits.length > 1) throw new Error(`Ambiguous id "${id}"`);
	if (!hits.length) throw new Error(`Unknown background task "${id}"`);
	return hits[0];
}

/** The bg_logs list: one summary per job, oldest first. */
export function list(): string[] {
	return lanes
		.flatMap((l) => [...l.store.values()].map((j) => [j.startedAt, l.spec.summary(j)] as const))
		.sort((a, b) => a[0] - b[0])
		.map((r) => r[1]);
}

/**
 * The model has the result now: suppress its wake-up and clear its unread
 * failure from the footer. Only a settled job has a result; reading one whose
 * work has not ended (a timeout in its grace period) leaves its wake-up due.
 */
export function observe(j: Job): void {
	if (j.completedAt !== null) notifier.read(j);
}

/** bg_logs for one job. Reading a finished job marks it read. */
export function read(j: Job, o: ReadOptions = {}): string {
	observe(j);
	return laneOf(j).spec.read(j, o);
}

/**
 * Stop a job. No wake-up, and the result counts as read from the moment the
 * kill is recorded, before the work has ended. True when the job was still in
 * flight; false when it had already finished (it is only marked read).
 */
export async function kill(j: Job): Promise<boolean> {
	if (!live(j)) {
		notifier.read(j);
		return false;
	}
	const l = laneOf(j);
	j.status = "killed";
	j.notifyOnCompletion = false;
	notifier.read(j);
	l.changed(j);
	await l.spec.stop(j);
	return true;
}

/** Session end: cancel queued work first, so a freed slot cannot start it, then stop what runs. */
export async function killAll(): Promise<void> {
	const all = lanes.flatMap((l) => [...l.store.values()]);
	await Promise.all(all.filter((j) => j.status === "queued").map(kill));
	await Promise.all(all.filter((j) => j.status === "running").map(kill));
}

export function count(jobs: Iterable<Job>): Counts {
	const c: Counts = { running: 0, failedUnread: 0 };
	for (const j of jobs) {
		if (j.status === "running") c.running++;
		else if (j.status === "failed" && unread(j)) c.failedUnread++;
	}
	return c;
}

const of = (name: string) => lanes.filter((l) => l.spec.name === name).flatMap((l) => [...l.store.values()]);

/** Footer counts per lane. */
export const counts = () => ({ bg: count(of("bg")), agents: count(of("agents")) });
