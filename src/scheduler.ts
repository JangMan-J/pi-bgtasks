/**
 * Run scheduler: first in, first out under a concurrency limit. A job holds a
 * slot from the moment it begins until its work's promise settles, so session
 * construction and teardown count. The state lives on globalThis, so a /reload
 * keeps one queue and one set of occupied slots.
 */

export interface Scheduler<J extends object> {
	/** Queue work. Resolves when the work has run, or when it is withdrawn before starting. Never rejects. */
	submit(job: J, start: () => Promise<void>): Promise<void>;
	/** Take a job out of the queue before it starts, and resolve its submit promise. False when it is not waiting. */
	withdraw(job: J): boolean;
	/** Waiting jobs, oldest first. */
	waiting(): J[];
	/** Set the limit (1..max, default max) and start what now fits. */
	setLimit(limit?: number): void;
}

export interface SchedulerOptions<J> {
	/** globalThis key of the shared state. */
	key: symbol;
	/** Default and ceiling of the limit. */
	max: number;
	/** Called as a job takes its slot, just before its work starts. */
	begin?(job: J): void;
	/**
	 * Work running outside this queue, such as runs an older build started before
	 * a /reload. Each holds a slot until its promise settles; one without a
	 * promise holds a slot while it is listed.
	 */
	foreign?(): Iterable<{ job: J; done?: Promise<unknown> }>;
}

// Entry field names match the state an earlier build left on globalThis.
interface Entry<J> {
	run: J;
	start: () => Promise<void>;
	finish: () => void;
}
interface State<J extends object> {
	limit: number;
	entries: Entry<J>[];
	slots: Set<J>;
	/** Jobs whose slot was released: never adopted again, even while still listed as foreign. */
	released: WeakSet<J>;
}

export function scheduler<J extends object>(o: SchedulerOptions<J>): Scheduler<J> {
	const g = globalThis as Record<symbol, any>;
	const s: State<J> = (g[o.key] ??= { limit: o.max, entries: [] });
	s.slots ??= new Set();
	s.released ??= new WeakSet();

	/** Occupy a slot until `done` settles. */
	const hold = (job: J, done: () => Promise<unknown>, after?: () => void) => {
		s.slots.add(job);
		let work: Promise<unknown>;
		try {
			work = done();
		} catch (err) {
			work = Promise.reject(err);
		}
		const release = () => {
			s.slots.delete(job);
			s.released.add(job);
			after?.();
			pump();
		};
		void work.then(release, release);
	};

	function pump(): void {
		const listed = new Set<J>();
		for (const { job, done } of o.foreign?.() ?? []) {
			if (s.slots.has(job) || s.released.has(job)) continue;
			if (done) hold(job, () => done);
			else listed.add(job);
		}
		while (s.slots.size + listed.size < s.limit && s.entries.length) {
			const e = s.entries.shift()!;
			hold(e.run, () => (o.begin?.(e.run), e.start()), e.finish);
		}
	}

	return {
		submit(job, start) {
			let finish!: () => void;
			const done = new Promise<void>((resolve) => (finish = resolve));
			s.entries.push({ run: job, start, finish });
			pump();
			return done;
		},
		withdraw(job) {
			const i = s.entries.findIndex((e) => e.run === job);
			if (i < 0) return false;
			s.entries.splice(i, 1)[0].finish();
			return true;
		},
		waiting: () => s.entries.map((e) => e.run),
		setLimit(limit = o.max) {
			if (!Number.isInteger(limit) || limit < 1 || limit > o.max) throw new Error("Invalid concurrency");
			s.limit = limit;
			pump();
		},
	};
}
