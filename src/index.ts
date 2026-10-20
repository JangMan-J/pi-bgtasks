/**
 * pi-background: background shell tasks (bg_run, bg_logs, bg_kill) and declared
 * in-process subagents (subagent). One notifier, one footer contract.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as agents from "./agents.ts";
import { boundary, flush, host, observed, publish } from "./host.ts";
import { resolveId, readTail, Type } from "./kit.ts";
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
		"Run a declared subagent in-process. Each agent is declared in .pi/agents/*.md or ~/.pi/agent/agents/*.md with its own prompt, tools and model.",
		"An undeclared name creates a read-only default agent (tools: read, grep, find, ls) and saves it as a declaration; pass `model` (provider/id) to choose its model, else it uses the current one.",
		"Foreground (default) returns a report: status, model, turns, tool calls, then the answer, or an explicit NO RESULT / FAILED / KILLED notice. background: true returns a task id and wakes a follow-up turn with the same report; bg_logs lists unread results.",
		`Declared agents:\n${list}`,
		...(errors.length ? [`${errors.length} invalid declaration(s) ignored.`] : []),
	].join("\n");
}

export default function backgroundExtension(pi: ExtensionAPI) {
	host.pi = pi;
	host.counts = () => ({ bg: shell.running().length, agents: agents.running().length });
	const bind = (ctx: ExtensionContext) => void (host.ctx = ctx);

	// ---- hooks -------------------------------------------------------------
	let described = "";
	pi.on("session_start", async (_e, ctx) => {
		bind(ctx);
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
		await Promise.all([shell.killAll(), agents.killAll()]);
		publish();
	});

	// ---- notification rendering (one visible line; the payload stays for the model) ----
	if (typeof pi.registerMessageRenderer === "function") {
		void import("@earendil-works/pi-tui" as string)
			.then(({ Text }: any) => {
				pi.registerMessageRenderer("bg-notification", (m: any, _o: any, theme: any) => {
					const d = m?.details ?? {};
					const color = d.status === "failed" ? "error" : d.status === "killed" ? "warning" : "success";
					const line = `[${d.kind === "agent" ? "agent" : "bg"} ${d.status ?? "done"}] ${d.name ?? ""} (${d.id ?? "?"})`;
					return new Text(theme?.fg ? theme.fg(color, line) : line, 0, 0);
				});
			})
			.catch(() => {});
	}

	// ---- tools -------------------------------------------------------------
	pi.registerTool({
		name: "bg_run",
		label: "Background Run",
		description:
			"Start a long-running shell command in the background; returns its taskId and logPath at once. Completion wakes a follow-up turn unless the result was already read with bg_logs. Do not sleep or poll.",
		promptSnippet: "Run a long-running shell command in the background; wakes a follow-up turn on completion.",
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
			"List background tasks and subagents, or read one: a shell task's output tail or a subagent's result. Reading a finished task suppresses its wake-up.",
		promptSnippet: "List background tasks/subagents or read one by taskId.",
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
		description: "Stop a running background task (its process group) or subagent by taskId.",
		promptSnippet: "Stop a running background task or subagent by taskId.",
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
			promptSnippet: "Run a declared in-process subagent, in the foreground or background.",
			parameters: Type.Object({
				agent: Type.String({ description: "Name of a declared agent, or a new name to create a read-only default." }),
				prompt: Type.String({ description: "Complete, self-contained task. The subagent sees nothing else." }),
				description: Type.Optional(Type.String({ description: "Short label for status display." })),
				model: Type.Optional(Type.String({ description: "provider/id for a newly created agent. Not allowed for a declared agent." })),
				background: Type.Optional(Type.Boolean({ description: "Return a task id now and wake on completion (default false)." })),
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
					const made = agents.defaultDeclaration(String(p.agent ?? ""), p.model?.trim() || "inherit");
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
