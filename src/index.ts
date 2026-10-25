/**
 * pi-background: background shell tasks (bg_run, bg_logs, bg_kill) and declared
 * in-process subagents (subagent). One notifier, one footer contract.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as agents from "./agents.ts";
import { boundary, clear, count, flush, host, observed, publish } from "./host.ts";
import { oneLine, readTail, resolveId, Type } from "./kit.ts";
import * as shell from "./shell.ts";

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

function find(id: string | undefined) {
	if (!id?.trim()) throw new Error("Missing taskId");
	const a = resolveId(agents.runs, id);
	const s = resolveId(shell.tasks, id);
	if (a && s) throw new Error(`Ambiguous id "${id}"`);
	if (!a && !s) throw new Error(`Unknown background task "${id}"`);
	return { agent: a, task: s };
}

function subagentDescription(cwd: string): string {
	const { agents: declared, errors } = agents.loadDeclarations(cwd);
	const list = [...declared.values()].map((d) => `- ${d.name}: ${d.description}`).join("\n") || "(none declared)";
	return [
		"Hand one bounded, self-contained piece of work to a fresh agent with its own context window, tools and model. Only its final report comes back, so your context stays small. Use it for adjacent work that needs none of your conversation: mapping or searching a codebase, reading many files or long logs, research, a review or second opinion, and each independent slice of a multi-part request. Start these with background: true, several in one turn, before you begin blocking work of your own. Keep work that is trivial (one or two calls) or that depends on context only you hold.",
		"The prompt is the whole brief: goal, paths, constraints, what counts as done, and the exact shape of the answer you want. The subagent sees nothing else: no conversation, no AGENTS.md, no attachments.",
		"Every run returns one report: a header (id, agent, state, model, turns, tool calls, duration), then the answer or an explicit NO RESULT / FAILED / KILLED notice. A report is evidence, not completion: check what matters before you report done. Foreground returns it directly; background returns an id and wakes a follow-up turn with it, and bg_logs lists reports not yet read.",
		"Agents are declared in .pi/agents/<name>.md (project) or ~/.pi/agent/agents/<name>.md, each with its own prompt, tools and model. An undeclared name creates a read-only default (read, grep, find, ls) and saves it there; model is then required (provider/id, or a bare model id, which prefers a subscription provider). Models are never inherited.",
		`Declared agents:\n${list}`,
		...(errors.length ? [`${errors.length} invalid declaration(s) ignored.`] : []),
	].join("\n");
}

export default function backgroundExtension(pi: ExtensionAPI) {
	// A subagent's session loads this extension too. It must not take over the
	// shared host (wake-ups and the footer belong to the parent), and it gets no tools.
	if (agents.buildingChild()) return;
	host.pi = pi;
	host.counts = () => ({ bg: count(shell.tasks.values()), agents: count(agents.runs.values()) });
	const bind = (ctx: ExtensionContext) => void (host.ctx = ctx);

	// ---- hooks -------------------------------------------------------------
	let described = "";
	pi.on("session_start", async (_e, ctx) => {
		bind(ctx);
		host.closed = false;
		publish();
		registerSubagent(ctx.cwd);
	});
	pi.on("turn_end", async (_e, ctx) => (bind(ctx), boundary() as any));
	pi.on("agent_before_settle", async (_e, ctx) => (bind(ctx), boundary() as any));
	pi.on("agent_settled", async (e, ctx) => {
		bind(ctx);
		if (!e.aborted) flush();
	});
	pi.on("session_shutdown", async (e) => {
		if (e.reason === "reload") return; // jobs survive a reload
		host.pending.clear();
		clear();
		await Promise.all([shell.killAll(), agents.killAll()]);
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
				const rows = [
					...[...shell.tasks.values()].map((t) => [t.startedAt, shell.summary(t)] as const),
					...[...agents.runs.values()].map((r) => [r.startedAt, agents.summary(r)] as const),
				].sort((a, b) => a[0] - b[0]);
				return text(rows.length ? rows.map((r) => r[1]).join("\n\n") : "No background tasks.");
			}
			const { agent, task } = find(p.taskId);
			if (task) {
				observed(task);
				const tail = readTail(task.logPath, p.maxBytes, p.tailLines ?? 80);
				return text(`${shell.summary(task)}\n\n--- Output tail (${tail.totalBytes} bytes total${tail.truncated ? ", truncated" : ""}) ---\n${tail.text}`);
			}
			observed(agent!);
			return text(agents.report(agent!));
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
			const { agent, task } = find(p.taskId);
			if (task) await shell.kill(task);
			else await agents.kill(agent!);
			const j = (task ?? agent)!;
			return text(`Stopped ${j.id} (${j.name}).`);
		},
	} as any);

	function registerSubagent(cwd: string) {
		const description = subagentDescription(cwd);
		if (description === described) return;
		described = description;
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description,
			promptSnippet: "Hand self-contained adjacent work (mapping, search, long reads, research, review, independent slices) to a fresh-context subagent; background: true to run several at once.",
			promptGuidelines: [
				"Before blocking work, start what can run beside it: bg_run for long commands, subagent with background: true for adjacent self-contained work, one call per independent part, all in the same turn.",
				"A subagent prompt is a complete brief: goal, paths, constraints, what counts as done, and the answer shape. It sees nothing of your conversation.",
				"Never wait by polling; completion wakes you. Report done only after every task and subagent you started has finished and its result is checked.",
			],
			parameters: Type.Object({
				agent: Type.String({ description: "A declared agent name, or a new name to create a read-only default." }),
				prompt: Type.String({ description: "The complete brief: goal, paths, constraints, done-criteria, answer shape. The subagent sees nothing else." }),
				description: Type.Optional(Type.String({ description: "Short label for status display." })),
				model: Type.Optional(Type.String({ description: "provider/id, or a bare model id (prefers a subscription provider). Required when creating a new agent; rejected for a declared one." })),
				background: Type.Optional(Type.Boolean({ description: "Return an id now and wake a follow-up turn with the report (default false: wait and return the report)." })),
			}),
			async execute(_id: string, p: any, signal: AbortSignal | undefined, _u: unknown, ctx: ExtensionContext) {
				bind(ctx);
				const { agents: declared, errors, invalid } = agents.loadDeclarations(ctx.cwd);
				let d = declared.get(p.agent);
				let note: string | undefined;
				if (!d) {
					if (invalid.has(p.agent)) {
						throw new Error(`Agent "${p.agent}" has an invalid declaration; fix it:\n${errors.filter((e) => e.includes(`${p.agent}.md:`)).join("\n")}`);
					}
					if (!p.model?.trim()) {
						const some = ctx.modelRegistry.getAvailable().slice(0, 20).map((m) => `${m.provider}/${m.id}`).join(", ");
						throw new Error(`Agent "${oneLine(String(p.agent ?? ""))}" is not declared. To create it, pass model (provider/id or model id). Available: ${some || "none"}.`);
					}
					const made = agents.defaultDeclaration(String(p.agent ?? ""), p.model.trim());
					d = made.decl;
					agents.resolveModel(ctx, d); // fail before saving anything
					const path = agents.saveDeclaration(ctx.cwd, d.name, made.text);
					note = `Note: "${d.name}" was not declared, so a read-only default agent (${agents.SAFE_TOOLS.join(", ")}; model ${d.model}) was ${
						path ? `created at ${path}. Edit it to customize.` : "used for this run only (could not save it)."
					}`;
				} else if (p.model) {
					throw new Error(`Agent "${d.name}" is declared with model ${d.model}; the model parameter only applies to a new agent.`);
				}
				const r = await agents.spawn(ctx, d, { prompt: p.prompt, description: p.description, background: p.background === true, signal, note });
				if (r.background) {
					return text(`Started subagent ${r.id} (${r.agent}: ${r.name}, ${r.model}).${note ? `\n${note}` : ""}\nCompletion will wake a follow-up turn with its report; bg_logs shows unread results.`, { id: r.id });
				}
				await r.done;
				r.resultObservedAt ??= Date.now();
				const out = agents.report(r);
				if (r.status !== "completed") throw new Error(out);
				return text(out, { id: r.id, turns: r.turns, toolCalls: r.toolCalls, model: r.model });
			},
		} as any);
	}
	registerSubagent(process.cwd());
}
