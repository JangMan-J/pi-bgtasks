/**
 * The one place that owns state outliving a /reload: the bound Pi session,
 * pending wake-ups and footer state, on globalThis. Child-process and session
 * callbacks created before a /reload therefore reach the *current* session.
 * Builds the wake-up notifier and the footer over that state, through the real
 * Pi port.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFooter, type FooterState, type LaneCounts } from "./footer.ts";
import { createNotifier, type NotifierState } from "./notifier.ts";
import { piPort } from "./port.ts";

interface Host extends NotifierState, FooterState {
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	/** Footer counts per lane; the extension entry installs the job ledger's. */
	counts: () => LaneCounts;
	/** Older builds kept the spinner's interval handle here. */
	spinner?: ReturnType<typeof setInterval>;
}

const KEY = Symbol.for("jang.pi.bg.host.v1");
const idle = () => ({ running: 0, failedUnread: 0 });
export const host: Host = ((globalThis as Record<symbol, Host>)[KEY] ??= {
	pending: new Map(),
	footer: new WeakMap(),
	frame: 0,
	counts: () => ({ bg: idle(), agents: idle() }),
});

// The object outlives /reload: fill what older builds lacked, stop their spinner.
host.pending ??= new Map();
host.footer ??= new WeakMap();
host.frame ??= 0;
if (host.spinner) {
	clearInterval(host.spinner);
	host.spinner = undefined;
}

export const port = piPort(host);
export const footer = createFooter(port, () => host.counts(), host);
/** A delivered or read result can clear an unread failure: repaint. */
export const notifier = createNotifier(port, host, () => footer.publish());
export const emit = port.emit;
