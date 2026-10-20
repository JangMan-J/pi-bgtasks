# pi-background

Background shell tasks and declared in-process subagents for Pi. Four tools, no commands, no settings.

| Tool | Does |
| --- | --- |
| `bg_run` | Start a shell command in the background. Returns an id and a log path. |
| `subagent` | Run a **declared** agent, foreground or `background: true`. |
| `bg_logs` | List tasks and subagents, or read one by id (shell tail or subagent result). |
| `bg_kill` | Stop one by id. |

Do not load it with `pi-bg-tasks` or `@gotgenes/pi-subagents`; the tool names clash.

## Declaring a subagent

A subagent exists only if a file declares all of it. Files: `<cwd>/.pi/agents/<name>.md` over `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/`). The project file wins by name. Edits apply on the next spawn.

```markdown
---
description: Reads code and reports findings
tools: read, grep, find, ls
model: inherit
thinking: high
max_turns: 20
---
You read code and report what you find. Do not edit files.
```

| Key | Required | Rule |
| --- | --- | --- |
| `description` | yes | One line, shown to the parent model. |
| `tools` | yes | Exact allowlist: names or `*` patterns, comma list or `[a, b]`. `none` means no tools. |
| `model` | yes | `provider/id`, or `inherit` to use the parent's model on purpose. |
| `thinking` | no | `off minimal low medium high xhigh max`. |
| `max_turns` | no | 1-500, default 30. Reaching it fails the run and keeps the partial result. |
| body | yes | The whole system prompt. No parent prompt, context files, skills, or conversation is inherited. |

### Undeclared names

Calling `subagent` with a name that has no file creates a safe default instead of failing: tools `read, grep, find, ls` (read-only), `max_turns` 30, a prompt that demands a written final answer. It is saved to `~/.pi/agent/agents/<name>.md` so it becomes a normal declaration you can edit; an existing file is never overwritten. The optional `model` parameter (`provider/id`) picks its model, else it inherits the current one. The model is checked before anything is saved, and the result tells the caller what was created and where. `model` on an already-declared agent is rejected: a declaration's model is authoritative. A name whose file exists but is invalid is an error, not a trigger to create.

Parsing is strict. An unknown key, a missing field, or a bad value makes that file invalid; it is not spawnable and the error is shown when the model asks for it. An invalid project file does not fall back to the global one it shadows.

A child never receives this extension's tools (`subagent`, `bg_*`), even through a `*` pattern. A declaration that names them is invalid.

## What the caller gets

Every outcome, foreground or in the wake-up, is one report: a header (id, agent, state, model, turns, tool calls, duration), then the outcome stated outright.

| State | Body |
| --- | --- |
| `COMPLETED` | The child's last message that contained text. Empty answers are never returned silently: `NO RESULT: the subagent finished without writing a final answer…` |
| `FAILED` | `FAILED: <reason>` (provider error, `max_turns` reached, start failure), then any partial output, labelled as partial. |
| `KILLED` | `KILLED before finishing.` plus partial output. |

Failures and kills throw in the foreground, so they arrive as tool errors. Output over 32 KB is cut with `[truncated: showing N of M characters]`; the 4 KB wake-up preview points to `bg_logs` for the rest. `bg_logs` marks finished jobs that were never read as `[completed, unread]`.

## Behaviour

- Foreground subagents return the result, or throw with the partial result on failure. Pi's abort stops them.
- Background jobs wake a follow-up turn once on completion. If the agent is busy, the result is injected at the next turn boundary. Reading it with `bg_logs` first suppresses the wake. `bg_kill` never wakes.
- Limits: 16 running shell tasks, 4 running subagents, 32 finished records kept per kind.
- Shell tasks run in their own process group (`bash -lc`): SIGTERM, then SIGKILL after 1.5 s. Logs are `0600` in a per-user `0700` directory (`PI_BG_LOG_DIR` overrides). Running groups are SIGKILLed if pi exits without its shutdown hook.
- Jobs survive `/reload`; callbacks reach the current extension instance. They are stopped on any other shutdown.
- Output placed in a wake-up message is XML-escaped and bounded.

## Footer

Two plain-text, single-line statuses through `ctx.ui.setStatus`, set only when the count is non-zero and removed at zero. No ANSI, no timers.

| Key | Text |
| --- | --- |
| `bg` | `[~] 2 bg` |
| `bg-agents` | `[~] 1 agent` |

Themed footers (zentui, starship) style and place them per key. Names and labels from tasks never reach the footer.

## Integration protocol

Unchanged from `pi-bg-tasks` v1, so existing readers (the simon-says bridge) keep working:
`globalThis[Symbol.for("jang.pi.bg.tasks.v1")]` (`Map<id, task>`), `globalThis[Symbol.for("jang.pi.bg.service.v1")]` (`{version, store, list, get}`), and `pi.events` `bg-tasks:changed` / `bg-tasks:terminal`.

Subagents add `globalThis[Symbol.for("jang.pi.bg.agents.v1")]` (`Map<id, run>`) and `bg-agents:changed` / `bg-agents:terminal`, payload `{version: 1, run}`.

## Known limits

- A model provider registered only at runtime by the parent is not copied into the child; the child loads extensions itself and gets what they register.
- Subagent extension tools come from the child's own extension load, so an allowlisted extension tool must be installed for the child.
