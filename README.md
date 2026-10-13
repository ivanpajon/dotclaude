# dotclaude

A [Claude Code](https://code.claude.com) plugin marketplace with my customizations: skills, agents, hooks, MCP servers, mods and plugins.

## Install

Add the marketplace once:

```
/plugin marketplace add ivanpajon/dotclaude
```

Then install what you want:

```
/plugin install workflow-budget@dotclaude
```

## Catalog

| Name | Type | What it does |
|---|---|---|
| [workflow-budget](skills/workflow-budget) | Skill | Caps multi-agent workflow size (40 agents by default), asks before going bigger, and uses cheaper verification patterns. |
| [workflow-monitor](mods/workflow-monitor) | Mod | Live pane of running workflows and subagents: model, effort, tokens, time and estimated cost. Opens by itself when a subagent starts, or with `/workflows`. |

## Layout

Each type has its own folder. Every item inside is a self-contained plugin, so each one installs on its own.

| Folder | Contains |
|---|---|
| `skills/` | Skills (`SKILL.md` + optional scripts and references) |
| `agents/` | Custom subagent definitions |
| `hooks/` | Hook-based automations |
| `mcps/` | MCP server configs and servers |
| `mods/` | Mods: changes to Claude Code's interface (panes, commands, tool-call hooks) |
| `plugins/` | Bundles that combine several of the above |

## Adding an item

1. Create `<type>/<name>/` with the component files and a `.claude-plugin/plugin.json`.
2. Add an entry to [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) with `"source": "./<type>/<name>"`.
3. Add a row to the catalog above.
4. Run `claude plugin validate .` from the repo root.

Plugin names must be kebab-case and can't start with `claude-`, `anthropic-` or `cc-plugin-`.

## License

[MIT](LICENSE)
