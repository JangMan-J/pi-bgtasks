/**
 * The seam to Pi: everything the wake-up notifier and the footer need from the
 * live session. Two adapters satisfy it: `piPort` here, over the bound session,
 * and a recording fake with a manual clock in the tests.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface Port {
	/** Wake the agent with a message. Throws or rejects when delivery failed. */
	send(message: object): void | Promise<unknown>;
	/** True while the agent is idle, and when that cannot be known. Never throws. */
	idle(): boolean;
	/** The UI to write the footer to; undefined without one. Never throws. */
	ui(): { setStatus(key: string, text: string | undefined): void } | undefined;
	/** Emit on Pi's event bus. Never throws. */
	emit(event: string, payload: unknown): void;
	/** Call `fn` every `ms` until the returned stop is called. Never keeps the process alive. */
	every(ms: number, fn: () => void): () => void;
}

/** The real adapter. Reads `pi` and `ctx` at each call, so it follows rebinding and /reload. */
export function piPort(session: { pi?: ExtensionAPI; ctx?: ExtensionContext }): Port {
	return {
		send(message) {
			if (!session.pi) throw new Error("no session to wake");
			return session.pi.sendMessage(message as any, { triggerTurn: true, deliverAs: "followUp" }) as void | Promise<unknown>;
		},
		idle() {
			try {
				return session.ctx?.isIdle?.() ?? true;
			} catch {
				return true; // stale context
			}
		},
		ui() {
			try {
				return session.ctx?.hasUI ? session.ctx.ui : undefined;
			} catch {
				return undefined; // stale or closing UI
			}
		},
		emit(event, payload) {
			try {
				(session.pi as any)?.events?.emit?.(event, payload);
			} catch {
				// event bus unavailable (stale instance)
			}
		},
		every(ms, fn) {
			const h = setInterval(fn, ms);
			h.unref?.();
			return () => clearInterval(h);
		},
	};
}
