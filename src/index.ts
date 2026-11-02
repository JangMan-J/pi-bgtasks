/**
 * pi-bgtasks: background shell tasks (bg_run, bg_logs, bg_kill) and runtime
 * in-process subagents (subagent). One notifier, one footer contract.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as agents from "./agents.ts";
import { footer, host, notifier } from "./host.ts";
import * as jobs from "./jobs.ts";
import { Type } from "./kit.ts";
import * as shell from "./shell.ts";

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

const SUBAGENT_DESCRIPTION = [
	"Hand one bounded, self-contained piece of work to a fresh agent with its own context window, tools and model. Only its final report comes back, so your context stays small. Use it for adjacent work that needs none of your conversation: mapping or searching a codebase, reading many files or long logs, research, a review or second opinion, and each independent slice of a multi-part request. Start these with background: true, several in one turn, before you begin blocking work of your own. Keep work that is trivial (one or two calls) or that depends on context only you hold.",
	"The prompt is the whole brief: goal, paths, constraints, what counts as done, and the exact shape of the answer you want. The subagent sees nothing else: no conversation, no AGENTS.md, no attachments.",
	"Every run returns one report: a header (id, agent, state, model, turns, tool calls, duration), then the answer or an explicit NO RESULT / FAILED / KILLED notice. While a subagent is running, bg_logs shows its latest assistant message as non-final progress. A report is evidence, not completion: check what matters before you report done. Foreground returns it directly; background returns an id and wakes a follow-up turn with it, and bg_logs lists reports not yet read.",
	"Specify the subagent at runtime (model, plus optional tools, systemPrompt, thinking, maxTurns). Defaults are read-only tools (read, grep, find, ls) and maxTurns 30; model is required on first use (provider/id, or a bare model id, which prefers a subscription provider) and never inherited. By default (save: true), the agent configuration is saved ephemerally in memory for the current session so later calls can reuse it by agent name alone; pass save: false for a one-off run.",
].join("\n");

export default function backgroundExtension(pi: ExtensionAPI) {
	// A subagent's session loads this extension too. It must not take over the
	// shared host (wake-ups and the footer belong to the parent), and it gets no tools.
	if (agents.buildingChild()) return;
	host.pi = pi;
	host.counts = jobs.counts;
	const bind = (ctx: ExtensionContext) => void (host.ctx = ctx);

	// ---- hooks -------------------------------------------------------------
	pi.on("session_start", async (_e, ctx) => {
		bind(ctx);
		const sid = (ctx as any).sessionManager?.getSessionId?.();
		if (host.sessionId !== undefined && sid !== undefined && host.sessionId !== sid) {
			agents.saved.clear();
		}
		if (sid !== undefined) host.sessionId = sid;
		footer.open();
	});
	pi.on("turn_end", async (e, ctx) => (bind(ctx), notifier.boundary(e as any) as any));
	pi.on("agent_before_settle", async (e, ctx) => (bind(ctx), notifier.boundary(e as any) as any));
	pi.on("agent_settled", async (e, ctx) => (bind(ctx), notifier.settle(e)));
	pi.on("session_shutdown", async (e) => {
		if (e.reason === "reload") return; // jobs and saved session agents survive a reload
		agents.saved.clear();
		host.sessionId = undefined;
		notifier.drop();
		footer.close();
		await jobs.killAll();
	});

	// ---- tools -------------------------------------------------------------
	pi.registerTool({
		name: "bg_run",
		label: "Background Run",
		description:
			"Start a shell command in the background and keep working. Use it for anything that would block you longer than a few seconds and whose output you do not need for your very next step: builds, test suites, installs, downloads, servers. Start these before work that must block. Returns taskId and logPath at once. When the command exits, a follow-up turn wakes you with the exit code and an output tail, so never sleep, poll, or spin on bg_logs. A standing daemon takes notifyOnCompletion: false. Before you report done, every task you started must have exited and been checked.",
		promptSnippet: "Start a long shell command in the background; a follow-up turn wakes on exit.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command, run with `bash -lc`." }),
			name: Type.Optional(Type.String({ description: "Short label for status display." })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Kill the task after this many seconds." })),
			notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Wake on exit (default true; false for standing daemons)." })),
		}),
		async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: ExtensionContext) {
			bind(ctx);
			const t = shell.start(ctx, p);
			return text(
				`Started background task ${t.id} (${t.name})\nPID: ${t.pid ?? "unknown"}\nLog: ${t.logPath}\n${
					t.notifyOnCompletion ? "Completion will wake a follow-up turn." : "Completion notification disabled."
				}`,
				{ id: t.id, pid: t.pid, logPath: t.logPath },
			);
		},
	} as any);

	pi.registerTool({
		name: "bg_logs",
		label: "Background Status & Logs",
		description:
			"List background tasks and subagents, or read one by id: a shell task's output tail, or a subagent's full report. Use it when a wake-up told you something finished and you need more than the preview, or when fresh state is needed for a control decision. It is not a way to wait: reading a finished task marks it read and cancels its wake-up; reading a running one only shows progress so far.",
		promptSnippet: "List background tasks and subagents, or read one's output or report by id.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Task id or unique prefix. Omit to list all." })),
			tailLines: Type.Optional(Type.Number({ description: "Shell output lines to return (default 80)." })),
			maxBytes: Type.Optional(Type.Number({ description: "Shell output bytes to read (default 16384, max 65536)." })),
		}),
		async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: ExtensionContext) {
			bind(ctx);
			if (!p.taskId) {
				const rows = jobs.list();
				return text(rows.length ? rows.join("\n\n") : "No background tasks.");
			}
			return text(jobs.read(jobs.find(p.taskId), p));
		},
	} as any);

	pi.registerTool({
		name: "bg_kill",
		label: "Background Kill",
		description:
			"Stop a running background task (its whole process group) or subagent by id. Use it when the work is no longer needed, has run away, or must be abandoned before you report. Killing never wakes a turn; partial output stays readable with bg_logs.",
		promptSnippet: "Stop a running background task or subagent by id.",
		parameters: Type.Object({ taskId: Type.String({ description: "Task id or unique prefix." }) }),
		async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: ExtensionContext) {
			bind(ctx);
			const j = jobs.find(p.taskId);
			const stopped = await jobs.kill(j);
			return text(stopped ? `Stopped ${j.id} (${j.name}).` : `${j.id} (${j.name}) was already ${j.status}; marked read.`);
		},
	} as any);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: SUBAGENT_DESCRIPTION,
		promptSnippet: "Hand self-contained adjacent work (mapping, search, long reads, research, review, independent slices) to a fresh-context subagent; background: true to run several at once.",
		promptGuidelines: [
			"Before blocking work, start what can run beside it: bg_run for long commands, subagent with background: true for adjacent self-contained work, one call per independent part, all in the same turn.",
			"A subagent prompt is a complete brief: goal, paths, constraints, what counts as done, and the answer shape. It sees nothing of your conversation.",
			"Never wait by polling; completion wakes you. Report done only after every task and subagent you started has finished and its result is checked.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Subagent name (reuses a session-saved agent, or names a runtime one)." }),
			prompt: Type.String({ description: "The complete brief: goal, paths, constraints, done-criteria, answer shape. The subagent sees nothing else." }),
			description: Type.Optional(Type.String({ description: "Short label for status display." })),
			model: Type.Optional(Type.String({ description: "provider/id, or a bare model id (prefers a subscription provider). Required unless agent is already saved in this session." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools (names or * patterns; empty for none). Defaults to read, grep, find, ls." })),
			systemPrompt: Type.Optional(Type.String({ description: "System prompt for the subagent. Defaults to a read-only research prompt." })),
			thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, max." })),
			maxTurns: Type.Optional(Type.Number({ description: "Maximum turns (1-500, default 30)." })),
			save: Type.Optional(Type.Boolean({ description: "Save this agent configuration ephemerally for the current session (default true; false for one-off)." })),
			background: Type.Optional(Type.Boolean({ description: "Return an id now and wake a follow-up turn with the report (default false: wait and return the report)." })),
			notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Background only. Wake on completion (default true); false to leave the report for bg_logs and the footer." })),
		}),
		async execute(_id: string, p: any, signal: AbortSignal | undefined, _u: unknown, ctx: ExtensionContext) {
			bind(ctx);
			const { decl: d, note } = agents.resolveDeclaration(ctx, p);
			const r = await agents.spawn(ctx, d, { prompt: p.prompt, description: p.description, background: p.background === true, notifyOnCompletion: p.notifyOnCompletion, signal, note });
			if (r.background) {
				return text(`${r.status === "queued" ? "Queued" : "Started"} subagent ${r.id} (${r.agent}: ${r.name}, ${r.model}).${note ? `\n${note}` : ""}\n${
					r.notifyOnCompletion ? "Completion will wake a follow-up turn with its report; bg_logs shows unread results." : "Completion notification disabled; read the report with bg_logs."
				}`, { id: r.id });
			}
			await r.done;
			jobs.observe(r); // the report is the tool result
			const out = agents.report(r);
			if (r.status !== "completed") throw new Error(out);
			return text(out, { id: r.id, turns: r.turns, toolCalls: r.toolCalls, model: r.model });
		},
	} as any);
}
