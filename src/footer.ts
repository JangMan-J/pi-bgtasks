/**
 * The footer: one status line under one key, so a user places this extension
 * once. Two lanes inside it, shell tasks then subagents: the count of running
 * jobs, a braille spinner while any run, and a red warning glyph while a
 * failure nobody has read is waiting. Same recipe as pi-webtasks, and the same
 * single channel: `setStatus`, the key every footer extension places by name.
 */
import type { Port } from "./port.ts";

/** Per lane: running now, and failures nobody has read or been woken with. */
export interface Counts {
	running: number;
	failedUnread: number;
}
export type LaneCounts = { bg: Counts; agents: Counts };

/** What outlives a /reload. */
export interface FooterState {
	/** Last text written per UI, so unchanged frames are not re-sent. */
	footer: WeakMap<object, string>;
	frame: number;
	/** Stops the running spinner; set only while one runs. */
	stopSpinner?: () => void;
	/** Set at session end, so late callbacks do not repaint a cleared footer. */
	closed?: boolean;
	/** The instance that opened last. Only it drives the spinner, so a stale instance's code never paints frames. */
	owner?: object;
}

export interface Footer {
	/** Show the current counts. Writes only when the text changed; spins while anything runs. Never throws. */
	publish(): void;
	/**
	 * Session start, including after a /reload: take the spinner over from any
	 * earlier instance, and show the footer, as dim zeros when idle. Only the
	 * parent session calls it, so a child session's load never stops the spinner.
	 */
	open(): void;
	/** Session end: remove the footer and stop the spinner. publish() does nothing until open(). */
	close(): void;
}

const FOOTER = { status: "bgtasks" } as const;
const LANES = {
	bg: { icon: "\uf489", code: 45 },
	agents: { icon: "\uf1ae", code: 141 },
} as const;

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_MS = 120;
const color = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;

/**
 * One lane. State changes the glyph and colour in place, never the width: dim
 * when idle, the lane colour while running, red with a warning glyph while an
 * unread failure waits.
 */
export function label(c: Counts, icon: string, code: number, frame = 0): string {
	const glyph = c.failedUnread ? "\uf071" : icon;
	const text = `${glyph} ${c.running}${c.running ? FRAMES[frame % FRAMES.length] : ""}`;
	return color(c.failedUnread ? 203 : c.running ? code : 240, text);
}

/** The one status line: shell lane, then agent lane. */
function compose(counts: LaneCounts, frame = 0): string {
	return [label(counts.bg, LANES.bg.icon, LANES.bg.code, frame), label(counts.agents, LANES.agents.icon, LANES.agents.code, frame)].join("  ");
}

export function createFooter(port: Port, counts: () => LaneCounts, state: FooterState): Footer {
	const self = {};

	function spin(busy: boolean): void {
		if (busy && !state.stopSpinner && state.owner === self) {
			state.stopSpinner = port.every(SPIN_MS, () => {
				state.frame = (state.frame + 1) % FRAMES.length;
				publish();
			});
		} else if (!busy && state.stopSpinner) {
			state.stopSpinner();
			state.stopSpinner = undefined;
			state.frame = 0;
		}
	}

	function publish(): void {
		try {
			const ui = port.ui();
			if (!ui || state.closed) return spin(false);
			const c = counts();
			spin(c.bg.running + c.agents.running > 0);
			const text = compose(c, state.frame);
			if (state.footer.get(ui) === text) return;
			state.footer.set(ui, text);
			ui.setStatus(FOOTER.status, text);
		} catch {
			// stale or closing UI: nothing to update
		}
	}

	return {
		publish,
		open() {
			state.owner = self;
			state.stopSpinner?.(); // an earlier instance's interval would keep painting with its code
			state.stopSpinner = undefined;
			state.closed = false;
			const ui = port.ui();
			if (ui) state.footer.delete(ui); // paint once per session start, even if the text matches
			publish();
		},
		close() {
			state.closed = true;
			spin(false);
			try {
				const ui = port.ui();
				if (!ui) return;
				ui.setStatus(FOOTER.status, undefined);
				state.footer.delete(ui);
			} catch {
				// UI already gone
			}
		},
	};
}
