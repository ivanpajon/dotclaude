---
name: workflow-budget
description: Caps the size of multi-agent workflows, which in ultracode mode can grow to hundreds of subagents. Load this skill before writing or running ANY Workflow script, whenever ultracode is on or the word "ultracode" appears, and whenever a plan would spawn more than a handful of subagents (fan-outs, finder pools, adversarial verification, loop-until-dry, judge panels, multi-phase workflow chains). It sets a default budget of 40 agents per workflow, says to ask the user before going over it, and replaces per-finding voting with batched verification.
---

# Workflow budget

Ultracode is thorough but expensive: a single task can spawn 250+ subagents. The concurrency limit doesn't help, because it only controls how many agents run at once. The rest queue up and run anyway. This skill limits the **total**.

These rules come on top of the workflow-authoring reference. Where they conflict, follow these. The exception is when the user explicitly asks for a bigger run in the current prompt.

## The budget

- **Default: at most 40 `agent()` calls per workflow,** counting every stage and every loop round.
- **Chained workflows share the budget.** When a task runs several workflows in sequence (understand → design → implement → review), they draw from the same 40 together, unless the user approves more.
- **What overrides the cap:** the user names a number of agents ("use up to 100 agents"), sets a token budget (`+500k`), or approves an estimate you gave them. Lifting the cap for one task doesn't lift it for later tasks.

## Estimate before you launch

Before every Workflow call, count the agents the script will spawn in the worst case: items × stages × verifiers × max loop rounds. Write that count as a one-line log at the top of the script.

If the estimate is **over 40**, don't launch. Ask the user first, giving:

- the estimated total and how you got it (e.g. "12 files × 2 stages + 3 batch verifiers + 1 synthesis = 28 per round, 2 rounds = 56"),
- the plan that fits in 40 and what it would leave out,
- the bigger plan and what it would add.

Then wait for their answer. A short question costs much less than 200 agents the user didn't want.

## Enforce it in the script

An estimate can be wrong, especially with loops, so put a hard guard in every script and call `capped()` instead of `agent()` directly:

```js
const CAP = 40   // raise only when the user approved a bigger number
let spawned = 0
function capped(prompt, opts) {
  if (spawned >= CAP) { log(`Agent cap ${CAP} reached, skipping: ${opts?.label ?? prompt.slice(0, 60)}`); return Promise.resolve(null) }
  spawned++
  return agent(prompt, opts)
}
```

Results may then contain `null`, so `.filter(Boolean)` them. If the cap was hit, say so in the final reply and list what was skipped. A run that was cut short must not look like full coverage.

## Cheaper patterns

Keep the quality ideas, and spend fewer agents on them:

- **Batch the work, not just the checks.** Give one finder or worker a group of related files (a directory, a module, about 5–10 files) instead of one agent per file. One agent per item is what turns 20 files into 60+ agents once later stages multiply it.

- **Dedupe before verifying.** Merge duplicate and near-duplicate findings in plain script code (by file + line or file + theme) before any verification stage, so no issue gets checked twice.

- **Verify by severity.** Only high- and medium-severity findings get a skeptic. Low-severity and style findings either go through one combined lightweight pass or are reported as "unverified, low severity".

- **Batch verification instead of voting.** Don't spawn 3–5 skeptics for each finding. Group findings, about 5–10 per batch (by file or theme), and give each batch to **one** skeptic agent prompted to refute each finding on its own and return a verdict for each. Use a second, independent skeptic only for high-severity findings the first one confirmed.

- **Loop-until-dry: at most 2 rounds.** Stop after one round that finds nothing new, not two.

- **Size finder pools to the work.** One finder per real subsystem or dimension, not a fixed large pool. Usually 3–6 finders cover a codebase-wide pass.

- **Judge panels:** 2–3 candidate approaches and one judge, not N attempts each scored by N judges.

- **Do cheap scouting yourself.** Listing files, grepping and reading a diff don't need subagents. Do them in the main conversation before writing the script.

- **Set effort on every `agent()` call.** Without `effort`, every agent inherits the session's effort, so a max-effort session runs every subagent at max. Set it explicitly:
  
  - Never `'max'`.
  - `'low'` only for very simple stages: extraction, formatting, listing, trivial checks.
  - `'medium'` or `'high'` for finders, workers and verifiers. This is the preferred default.
  - `'xhigh'` only when a stage really needs it, such as a hard final judge. Say why in a code comment.
  
  If the user names an effort for subagents, use that instead.

- **Write explicit, detailed agent prompts.** Each prompt should state the goal, the exact files or scope, what to return (use a `schema` where possible) and when to stop. Agents that don't have to rediscover context finish faster and use fewer tokens.

## Ultracode itself

Ultracode still means: aim for the most correct answer, and orchestrate when it helps. Under this skill it no longer means "token cost is not a constraint". Choose the strongest design that fits in 40 agents. Trivial or conversational tasks still get no workflow at all, and a question that only mentions ultracode is not a request to run one.
