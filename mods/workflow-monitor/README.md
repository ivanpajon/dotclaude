# workflow-monitor

A live pane in Claude Code for your running **workflows** and **subagents**. Every agent gets a row with its model, effort, tokens, elapsed time and estimated cost, and every workflow gets a card that says at a glance where it stands, even folded. From the pane you can pause, stop or retune any agent while it runs, and read what it is doing.

It works in the terminal and in the desktop app.

## Install

```
/plugin marketplace add ivanpajon/dotclaude
/plugin install workflow-monitor@dotclaude
```

The pane opens by itself when a subagent starts while none was running, and `/workflows` opens it any time. To try it now with sample data (`/workflows clear` removes it afterwards):

```
/workflows demo
```

## Commands

| Command | What it does |
|---|---|
| `/workflows` | Open the pane. It also opens by itself when a subagent starts. |
| `/workflows demo` | Load a sample workflow to try the pane out: running, paused and stopped agents, phases, Inspect. |
| `/workflows clear` | Remove finished, archived and demo agents. Running ones stay. |
| `/workflows help` | Show the commands, the pane's controls and the status icons. |

## The pane

### Cards

Each workflow run is a card, and so are the plain subagents started with the Agent tool (one **Subagents** card). A card shows:

- **Header:** the workflow's name, its status chip, **⚙** for its settings, and **✕** once none of its agents is running.
- **Summary:** how long it has been running, how many agents it started, their tokens, and their estimated cost. For a workflow the time is wall-clock time with no agent working left out; for the Subagents card it is the sum of each subagent's working time.
- **Description and phases:** taken from the workflow script's `export const meta` (`name`, `description`, `phases`). Agents are grouped by the prefix of their label (`investigate:payment-flow` goes under **Investigate**), in the order the script's `phases` declare; a prefix it doesn't declare still gets its own phase, and agents without one go under **Agents**. Each phase shows how many of its agents finished and a progress square per agent.
- **Agent rows**, described below.

A card stays unfolded while its group is still going: agents working, paused or stopping, or a workflow between phases. Meanwhile, cards that are over fold. The border is blue while an agent works and amber while they are paused. Once no card is still going, only the newest one stays unfolded. Click a card's name to fold or unfold it yourself; your choice then sticks.

### Agent rows

| Column | Shows |
|---|---|
| Status | ● working · ⏸ paused · ⏹ stopped · ✓ done · ✗ failed |
| Agent | The agent's label, cut short with "…" when space runs out |
| Model | `Opus 5.5`, `Sonnet 5.5`, … |
| Effort | `Low`, `Medium`, `High`, `Extra high` (in red) |
| Tokens | Input, output and cache tokens together |
| Time | Elapsed time, counting live; paused time is left out |
| Cost | Estimated cost (see [Cost](#cost)) |
| ⚙ / ↗ | **⚙** opens a running agent's settings; **↗** opens a finished agent's Inspect view |

Once a model or effort set from the pane (on the agent or its card) has applied to one of the agent's requests, its Model and Effort cells are highlighted.

The layout is responsive and never hides a column. As the pane narrows, the agent name gets shorter; once it would drop under 12 characters, each agent goes on two lines, with every column's value on the second.

### Status chip

The chip in a card's header sums up the group. It starts with where the group stands, then adds a mark for each other kind of agent in it:

| Lead | Means |
|---|---|
| ● | Agents are working |
| ⏸ | Agents are paused (with "…" while a pause is still on its way) |
| ⏹ | Agents are stopping ("…"), or the run was stopped |
| ○ | No agent is working, but the run hasn't ended: it may be between phases. Shows how long it has been quiet |
| ✓ | The run completed |
| ⚠ | The workflow's script threw an error |
| ✗ | Its agents failed and none finished |

How a workflow ended comes from its task notification. The Subagents card has no run to end: once none of its agents runs, its lead comes from the agents themselves. So does a workflow that never says how it ended, after 10 quiet minutes. The lead is then ✓ if any agent finished, else ✗ if any failed, else ⏹.

Examples:

- `● 5 working`: one state alone keeps its word (on the narrowest panes it shortens to `●5`).
- `● 2 · ⏸ 1 · ✗ 1 · ⏹ 1 · ✓ 3`: several states show only icons and counts. On narrower panes the same chip reads `●2 ⏸1 ✗1 ⏹1 ✓3`.
- `✓ 0 · ✗ 3`: the run completed, but none of its agents did.
- `⚠ script failed`: the run's own script threw.

## Controls

### ⚙ Settings panel

On a **running agent's row**, ⚙ opens a panel under it with:

- **Pause / Resume.** Pause holds the agent's next model request until you resume it, so it stops between steps without losing anything.
- **Stop.** Ends the agent now: its next request is answered with a final reply in the model's place, and further tool calls are refused, so it winds down cleanly.
- **Model** and **Effort** pickers. They apply from the agent's next request.
- **Inspect**, to open its activity.

On a **card's header**, ⚙ opens the same for the whole group: **Pause all / Resume all**, **Stop all**, and a model and effort for every agent in it, including agents the workflow starts later. An agent's own setting wins over the card's. Once nothing in the card is running, **Archive** and **Remove** take the place of Pause all and Stop all; the model and effort pickers stay, for agents the workflow starts later.

The icon shows **◆** while a model or effort is set, and **▴** while its panel is open.

### ↗ Inspect

Opens the Inspect view in another tab: the agent's latest activity, its thinking, text and tool calls (the last 80 entries), with its status, model, effort and tokens on top. A running agent's Inspect follows along live and has Pause and Stop too.

### ✕ Archive

Takes a card off the board once none of its agents is running: a finished workflow, one between phases, or the Subagents card. It isn't deleted: it moves under **Archived (n)** at the bottom of the pane. Click that line to unfold it, and there:

- **Restore** brings a card back to the board as it was.
- **Remove** deletes it from the monitor for good. **Remove all** does that for everything archived.

If an archived workflow starts another agent, its card comes back by itself. Archiving and removing only change what the monitor shows: the workflow's own output, files and transcript are never touched.

## Cost

Cost is an estimate from Anthropic's list prices per million tokens (input, output, cache write, cache read), matched by model. It shows what the tokens would cost on the API; on a subscription plan it isn't what you are billed. Models it doesn't know show `—`. The prices live in `PRICES` in [`hooks/register.tsx`](hooks/register.tsx).

## Notes and limits

- The monitor keeps its data for the current session only: a new session starts with an empty board.
- It lists agents that start after it loads. It keeps the latest 500 agents and the latest 200 activity entries per agent.
- Workflow names, descriptions and phases come from the script's `meta`, read from where the Workflow tool saved it. If the script can't be read, the name and description come from the Workflow tool's launch result (or the script's file name) and the card has no phases. With neither, the card is named after its run id.

## Development

| File | What it is |
|---|---|
| [`hooks/hooks.json`](hooks/hooks.json) | Tells Claude Code to load `register.tsx` |
| [`hooks/register.tsx`](hooks/register.tsx) | The mod: hooks, state and both panes |
| [`hooks/ticker.tsx`](hooks/ticker.tsx) | Runs on the drawing surface so timers count without redrawing the pane |
| [`hooks/monitor.test.ts`](hooks/monitor.test.ts) | Tests |
| [`types/index.d.ts`](types/index.d.ts) | The state the mod keeps, declared for type checking |

From this folder:

```
claude plugin validate .
claude plugin test .
```

To try changes in a session without installing, start Claude Code from this folder with `claude --plugin-dir .` (or `--plugin-dir mods/workflow-monitor` from the repo root).

## License

[MIT](../../LICENSE)
