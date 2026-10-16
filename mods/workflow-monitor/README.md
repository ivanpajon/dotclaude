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
| `/workflows demo` | Load a sample workflow to try the pane out: running, paused and stopped agents, phases, transcripts. |
| `/workflows clear` | Remove finished, archived and demo agents. Running ones stay. |
| `/workflows help` | Show the commands, the pane's controls and the status icons. |

## The pane

### Cards

Each workflow run is a card, and so are the plain subagents started with the Agent tool (one **Subagents** card). The pane follows the look of Claude Code's own Background tasks panel: cards still going are listed under **Running** and the rest under **Finished**. On the desktop the cards are filled panels with rounded corners and no visible border; in the terminal they keep a rounded border. A card shows:

- **Header:** the workflow's name, its status chip, **⚙** for its settings, and **✕** once none of its agents is running.
- **Summary:** how long it has been running, how many agents it started, their tokens, and their estimated cost. For a workflow the time is wall-clock time with no agent working left out; for the Subagents card it is the sum of each subagent's working time.
- **Description and phases:** taken from the workflow script's `export const meta` (`name`, `description`, `phases`). Agents are grouped by the phase the script ran them in (`phase()`, or the `phase` option of `agent()`), in the order the script's `phases` declare. The phase comes from the agent's files in the session folder; when none is recorded there, the prefix of the agent's label stands in (`investigate:payment-flow` goes under **Investigate**), a prefix the script doesn't declare still gets its own phase, and agents without either go under **Agents**. Each phase has a header with how many of its agents finished, a small square per agent (grey once done, blue while working, amber while paused, red if it failed, an outline if it was stopped), and a chevron. Click the phase's name, count or chevron to fold or unfold its table of agents; on the desktop, a click anywhere on the header does it. A phase that has agents starts unfolded. On the desktop an unfolded phase header is filled; a folded one shows its fill only while the pointer is on it. While a workflow is still going, the phases its script declares that haven't started any agent yet are listed too, greyed out, with no count.
- **Agent rows**, described below.

A card stays unfolded while its group is still going: agents working, paused or stopping, or a workflow between phases. Meanwhile, cards that are over fold. In the terminal, the border is blue while an agent works and amber while they are paused. Once no card is still going, only the newest one stays unfolded. Click a card's name to fold or unfold it yourself; your choice then sticks.

### Agent rows

| Column | Shows |
|---|---|
| Status | ● working · ⏸ paused · ⏹ stopped · ✓ done · ✗ failed. A finished agent's row is dimmed, with a grey ✓ |
| Agent | The agent's label, cut short with "…" when space runs out |
| Model | `Opus 5.5`, `Sonnet 5.5`, … |
| Effort | `Low`, `Medium`, `High`, `Extra high` (in orange while the agent runs), `Max` (in red while the agent runs) |
| Tokens | Input, output and cache tokens together |
| Time | Elapsed time, counting live; paused time is left out |
| Cost | Estimated cost (see [Cost](#cost)) |
| ⚙ / ↗ | **⚙** opens a running agent's settings; **↗** opens a finished agent's transcript |

A model or effort set from the pane (on the agent or its card) shows in the agent's row at once, in purple: Model for a model, Effort for an effort, both for both. The agent uses it from its next request. Set back to **Inherit**, the agent's own model or effort comes back, in its plain color. A finished agent's row shows what its last request was sent with.

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

- **Pause / Resume.** Pause holds the agent at its next tool call until you resume it, so it stops between steps without losing anything. A model request already under way finishes first, and an agent that answers without calling a tool finishes instead of waiting. It waits at a tool call because Claude Code ends a background or workflow agent that shows no progress for 10 minutes (and starts it again), and a tool call that is still running doesn't count as no progress. While it waits, the monitor runs a short sleeper process (`ping` on Windows, `sleep` elsewhere) every 30 seconds, since a hook can't otherwise wait more than 10 seconds. If no wait process will start, the pause is lifted instead of seeming to hold: a toast and a note in its transcript say so.
- **Stop.** Ends the agent now: its next request is answered with a final reply in the model's place, and further tool calls are refused, so it winds down cleanly.
- **Model** and **Effort** pickers. They apply from the agent's next request.
- **↗ Inspect**, to open its transcript.

On a **card's header**, ⚙ opens the same for the whole group: **Pause all / Resume all**, **Stop all**, and a model and effort for every agent in it, including agents the workflow starts later. An agent's own setting wins over the card's. Once nothing in the card is running, **Archive** and **Remove** take the place of Pause all and Stop all. The model and effort pickers stay while the workflow may still start agents (between phases), and on the Subagents card, which new subagents can join at any time. Once a workflow has ended (done, failed or stopped), they are hidden: there is nothing left for them to apply to.

The gear shows **▴** while its panel is open. A model or effort set there shows at once in the agents' rows, in purple (see [Agent rows](#agent-rows)).

### ↗ Inspect

Opens the agent's transcript in a tab of its own, titled with its description. Each agent gets its own tab, so several transcripts can be open at once; Inspect on an agent whose tab is already open reuses that tab, and removing an agent from the monitor closes it. The transcript is laid out like Claude Code's own **View transcript** for a subagent:

- **Model** and **Effort** on top. While the agent runs, **Pause** and **Stop** sit beside them; once it is over, how it ended (Completed, Stopped or Failed).
- **The prompt** it was given, in a filled box. A prompt over 1200 characters is cut to about twelve lines, with **Show more** to read it whole. For a workflow agent this is the task its script computed. The harness's copy of your request and Claude Code's reminders are left out.
- **Its replies**, as markdown, in order. Each run of tool calls between them is one line in Claude Code's own wording, such as `Ran 10 commands, used a tool` or `Read and edited cart.ts`. A trailing `(a tool failed)` means its last call failed, shown once that run is over. Click the line to list each call: the command's description, the file, the pattern or the page, marked `(failed)` when it failed.
- **Its answer** last: the report a subagent hands back, or a workflow agent's structured result, each field under its name. An agent that ended without an answer says `No result — task stopped` (or failed, or ended). A last reply counts as the answer only when the agent completed: a workflow agent that failed because it never returned the result its script asked for shows its reply and `No result — task failed`.
- **Totals** at the bottom: tool calls, tokens (the same count as its row) and time, counting live while it runs. Above them, while it works, what it is doing now, such as `Running a command…` or `Thinking…`.

The transcript is read from the file Claude Code keeps for the agent in the session folder and follows along live; each redraw parses only what was added. A file over 4 MiB (common for long workflow agents) is more than a mod can read in one go, so it comes through the system's own reader (`type` on Windows, `cat` elsewhere), every 3 seconds at most while the agent works. A plain subagent's can also come from the session itself. When neither can be read (as for the demo's agents), it is rebuilt from the activity the monitor saw stream: the latest 200 entries. If Claude Code ended the agent itself after it showed no progress, the transcript says so, how long it had been quiet, and which attempt took over.

### ✕ Archive

Takes a card off the board once none of its agents is running: a finished workflow, one between phases, or the Subagents card. It isn't deleted: it moves under **Archived (n)** at the bottom of the pane. Click that line to unfold it, and there:

- **Restore** brings a card back to the board as it was.
- **Remove** deletes it from the monitor for good. **Remove all** does that for everything archived.

If an archived workflow starts another agent, its card comes back by itself. Archiving and removing only change what the monitor shows: the workflow's own output, files and transcript are never touched.

## Cost

Cost is an estimate from Anthropic's list prices per million tokens (input, output, cache write, cache read), matched by model. It shows what the tokens would cost on the API; on a subscription plan it isn't what you are billed. Models it doesn't know show `—`. The prices live in `PRICES` in [`hooks/register.tsx`](hooks/register.tsx).

## Notes and limits

- The monitor keeps its data for the current session only: a new session starts with an empty board.
- It lists agents that start after it loads. Agents already running when it loaded join at their next model request, and their tokens count from then. It keeps the latest 500 agents and, for transcripts it can't read from the session's files, the latest 200 activity entries per agent.
- When Claude Code starts a stalled agent again, the new attempt joins the same card as `label (retry N)`, and the first attempt shows as stopped. A pause or stop, model or effort set on the first attempt carries over. Claude Code doesn't tell mods about these attempts, so the monitor finds them, and agents running before it loaded, in the session's files.
- On the desktop, the live times and the phase headers' click areas run in one frame that the app shares among them. When one of them is slow to draw (a reload can cause it), the app takes the whole frame down, and each area shows a one-line error in its place until the pane redraws. So the monitor only uses these areas where they are needed: for times still counting, and for a header's click area only while the pointer is on it. After a failure it draws each area fresh. One that keeps failing (3 times in 10 minutes) is drawn plain until it settles: its time then moves only when the pane redraws, and the phase's name, count and chevron become buttons again.
- Workflow names, descriptions and phases come from the script's `meta`, read from where the Workflow tool saved it. If the script can't be read, the name and description come from the Workflow tool's launch result (or the script's file name) and the card has no phases, unless it is a resumed run, which keeps the description and phases its first launch gave. With neither, the card is named after its run id.

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
