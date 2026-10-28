/**
 * Wake-up notifier: gets a finished job's result to the model exactly once,
 * without interrupting it. An idle agent is woken at once; a busy one gets the
 * result at its next turn boundary, or after it settles. Reading the result
 * (bg_logs, a kill, a foreground return) withdraws the wake-up.
 */
import { live, unread, type Notifiable } from "./kit.ts";
import type { Port } from "./port.ts";

export interface Message {
	customType: "bg-notification";
	content: string;
	/** Never shown in the transcript: the footer is the user's signal, the content is the model's. */
	display: false;
	details: { kind: "shell" | "agent"; id: string; name: string; status: string };
}

interface Pending {
	job: Notifiable;
	build: () => Message;
}

/** What outlives a /reload: wake-ups not yet delivered, by job id. */
export interface NotifierState {
	pending: Map<string, Pending>;
	/** Counts drops, so a send that fails after the session ended does not come back. */
	epoch?: number;
}

export interface Notifier {
	/** A job reached a terminal state. Nothing happens unless it is due: notifyOnCompletion and unread. */
	settled(job: Notifiable, build: () => Message): void;
	/** The model has the result: stamp it read and withdraw its wake-up. A live job is ignored. */
	read(job: Notifiable): void;
	/**
	 * Turn boundary (turn_end, agent_before_settle). Appends due wake-ups to the
	 * entries earlier handlers produced, and asks Pi to continue so the model
	 * sees them. Undefined when there is nothing to add: the entries stay as they are.
	 */
	boundary(event: { entries?: unknown[] }): { entries: unknown[]; continue: true } | undefined;
	/** agent_settled: send what is still pending, unless the run was aborted. */
	settle(event: { aborted?: boolean }): void;
	/** Session end: forget every pending wake-up. */
	drop(): void;
}

const due = (j: Notifiable) => j.notifyOnCompletion && unread(j);

/**
 * `changed` runs whenever a job's read or delivered stamp changes, so the
 * footer can clear (or restore) an unread failure.
 */
export function createNotifier(port: Port, state: NotifierState, changed: () => void = () => {}): Notifier {
	const { pending } = state;
	state.epoch ??= 0;

	function send(p: Pending): void {
		const { job } = p;
		const epoch = state.epoch;
		job.notificationDeliveredAt = Date.now();
		pending.delete(job.id);
		const undo = () => {
			job.notificationDeliveredAt = null;
			if (state.epoch === epoch) pending.set(job.id, p);
			changed();
		};
		try {
			const r = port.send(p.build());
			if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(undo);
		} catch {
			undo();
		}
	}

	return {
		settled(job, build) {
			if (!due(job)) return;
			if (!port.idle()) return void pending.set(job.id, { job, build });
			send({ job, build });
			changed();
		},
		read(job) {
			if (live(job)) return;
			job.resultObservedAt ??= Date.now();
			pending.delete(job.id);
			changed();
		},
		boundary(event) {
			const ours: unknown[] = [];
			for (const [id, p] of [...pending]) {
				pending.delete(id);
				if (!due(p.job)) continue;
				p.job.notificationDeliveredAt = Date.now();
				ours.push({ type: "custom_message", ...p.build() });
			}
			if (!ours.length) return undefined;
			changed();
			return { entries: [...(event.entries ?? []), ...ours], continue: true };
		},
		settle(event) {
			if (event.aborted || !pending.size) return;
			for (const p of [...pending.values()]) {
				if (due(p.job)) send(p);
				else pending.delete(p.job.id);
			}
			changed();
		},
		drop() {
			state.epoch!++;
			pending.clear();
		},
	};
}
