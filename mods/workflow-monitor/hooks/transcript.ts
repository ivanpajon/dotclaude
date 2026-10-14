import type { SessionMessage } from 'claude-code'

import type { LogEntry } from '../types'

// An agent's transcript as the View transcript pane draws it, as Claude Code's own does for a
// subagent: the prompt it was given, then its replies in order, each run of tool calls between
// them folded into one line ("Ran 10 commands, used a tool"), and its answer last.

export type Call = {
  id: string
  tool: string
  input: Record<string, unknown>
  /** Its result is in. */
  done: boolean
  failed: boolean
  /** What to show after its name when its input isn't known (the live log keeps a summary). */
  meta?: string
}

export type Entry =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tools'; calls: Call[] }
  /** A message sent to the agent after its prompt. */
  | { kind: 'user'; text: string }
  /** Something the monitor did to it ("Stopped from the workflow monitor."). */
  | { kind: 'note'; text: string }

export type Transcript = {
  prompt?: string
  entries: Entry[]
  /** Its answer, when it handed one back through a tool (SubagentHandback, StructuredOutput). */
  result?: string
  calls: number
}

// A workflow's harness frames what it hands an agent: the person's request, for context, then the
// task the script computed, each line indented by two spaces.
const HARNESS = '[Workflow harness'
const COMPUTED = '[Workflow harness — computed task]'

// What a person would call the agent's own input, or nothing: reminders and the harness's relay
// of the person's request are the engine's, not the caller's.
function asked(text: string): string | undefined {
  const t = text.trim()
  if (!t || t.startsWith('<system-reminder>')) return undefined
  if (t.startsWith(COMPUTED)) return t.split('\n').slice(1).map(l => l.replace(/^ {2}/, '')).join('\n').trim() || undefined
  if (t.startsWith(HARNESS)) return undefined
  return t
}

class Builder {
  t: Transcript = { entries: [], calls: 0 }
  byId = new Map<string, Call>()
  ask(text: string) {
    const said = asked(text)
    if (said === undefined) return
    if (this.t.prompt === undefined) this.t.prompt = said
    else this.t.entries.push({ kind: 'user', text: said })
  }
  text(text: string) {
    if (text.trim()) this.t.entries.push({ kind: 'text', text: text.trim() })
  }
  thinking(text: string) {
    if (text.trim()) this.t.entries.push({ kind: 'thinking', text: text.trim() })
  }
  call(c: Call) {
    this.t.calls++
    this.byId.set(c.id, c)
    const last = this.t.entries.at(-1)
    if (last?.kind === 'tools') last.calls.push(c)
    else this.t.entries.push({ kind: 'tools', calls: [c] })
    // The answer handed back through a tool still counts as one of its calls, as Claude Code's own
    // view counts it ("used a tool"), and is drawn after them.
    if (c.tool === 'SubagentHandback' && typeof c.input.message === 'string') this.t.result = c.input.message
    if (c.tool === 'StructuredOutput') this.t.result = structured(c.input)
  }
  answered(id: string, failed: boolean) {
    const c = this.byId.get(id)
    if (c) { c.done = true; c.failed = failed }
  }
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }
type Line = { type?: string; isMeta?: boolean; message?: { content?: string | Block[] } }

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```'
// A workflow agent's answer to its schema, to read: each field under its name, a text as the
// markdown it usually is, anything else as JSON.
const structured = (o: Record<string, unknown>) => {
  const fields = Object.entries(o)
  if (!fields.length) return json(o)
  return fields.map(([k, v]) => `**${k}**\n\n${typeof v === 'string' ? v : json(v)}`).join('\n\n')
}

/**
 * Reads the transcript file Claude Code writes for a subagent (`agent-<id>.jsonl`, one block a
 * line) as it grows: each feed parses only what was added since the last. A last line with no
 * newline yet is taken once it parses whole; one still being written waits for the rest.
 */
export class Reader {
  private b = new Builder()
  private rest = ''
  /** How much of the file it was fed, in characters. */
  fed = 0
  get transcript(): Transcript { return this.b.t }
  feed(text: string): this {
    this.fed += text.length
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? ''
    for (const raw of lines) if (raw.trim()) this.line(parse(raw))
    const last = this.rest.trim() ? parse(this.rest) : undefined
    if (last) { this.line(last); this.rest = '' }
    return this
  }
  private line(m: Line | undefined) {
    if (!m) return
    const b = this.b
    const content = m.message?.content
    if (m.type === 'user') {
      if (m.isMeta) return
      if (typeof content === 'string') b.ask(content)
      else if (Array.isArray(content)) {
        const results = content.filter(x => x.type === 'tool_result')
        for (const r of results) b.answered(r.tool_use_id ?? '', !!r.is_error)
        if (!results.length) for (const x of content) if (x.type === 'text' && x.text) b.ask(x.text)
      }
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const x of content) {
        if (x.type === 'text') b.text(x.text ?? '')
        else if (x.type === 'thinking') b.thinking(x.thinking ?? '')
        else if (x.type === 'tool_use') b.call({ id: x.id ?? '', tool: x.name ?? 'tool', input: record(x.input), done: false, failed: false })
      }
    }
  }
}

const parse = (raw: string): Line | undefined => {
  try { return JSON.parse(raw) as Line } catch { return undefined }
}

/** From a whole transcript file (see Reader). */
export function fromJsonl(jsonl: string): Transcript {
  return new Reader().feed(jsonl).transcript
}

/** From the session's own rows (`$.session.messages({ agentId })`). */
export function fromMessages(rows: SessionMessage[]): Transcript {
  const b = new Builder()
  for (const r of rows) {
    if (r.role === 'user') { if (r.text) b.ask(r.text); continue }
    b.text(r.text)
    for (const u of r.toolUses) b.call({ id: u.tool_use_id, tool: u.tool, input: record(u.input), done: u.text !== undefined, failed: !!u.isError })
  }
  return b.t
}

/**
 * From the monitor's own log of the agent's stream, when nothing else can be read. A call is known
 * by its place in the whole stream, which it keeps as the oldest entries fall off the log.
 */
export function fromLog(log: LogEntry[], prompt?: string): Transcript {
  const b = new Builder()
  if (prompt) b.ask(prompt)
  log.forEach((x, i) => {
    if (x.kind === 'text') b.text(x.text)
    else if (x.kind === 'thinking') b.thinking(x.text)
    else if (x.kind === 'note') b.t.entries.push({ kind: 'note', text: x.text })
    else b.call({ id: `log-${x.at ?? i}`, tool: x.tool ?? 'tool', input: {}, done: true, failed: false, meta: x.text })
  })
  return b.t
}

// A tool's kind, as Claude Code's own summary sorts them; anything else (MCP tools among them) is
// "used a tool".
const KIND: Record<string, string> = {
  Bash: 'bash', BashTool: 'bash', PowerShell: 'bash',
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'notebook',
  Glob: 'glob', Grep: 'grep', WebSearch: 'web', WebFetch: 'fetch',
  Agent: 'agent', Task: 'agent', TodoWrite: 'todo', REPL: 'code', JavaScript: 'code',
}
const kindOf = (tool: string) => KIND[tool] ?? 'other'
const FILE_KINDS = ['read', 'edit', 'write']

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`)
// Each kind's verb, and what it did that to, counted.
const PART: Record<string, [string, (n: number) => string]> = {
  bash: ['ran', n => count(n, 'a command', 'commands')],
  read: ['read', n => count(n, 'a file', 'files')],
  write: ['created', n => count(n, 'a file', 'files')],
  edit: ['edited', n => count(n, 'a file', 'files')],
  notebook: ['edited', n => count(n, 'a notebook', 'notebooks')],
  glob: ['found', () => 'files'],
  grep: ['searched', () => 'code'],
  web: ['browsed', () => 'the web'],
  fetch: ['fetched', n => count(n, 'a page', 'pages')],
  agent: ['ran', n => count(n, 'an agent', 'agents')],
  todo: ['updated', () => 'todos'],
  code: ['ran', () => 'code'],
  other: ['used', n => count(n, 'a tool', 'tools')],
}

const str = (c: Call, key: string) => (typeof c.input[key] === 'string' ? c.input[key] as string : undefined)
const fileOf = (c: Call) => str(c, 'file_path') ?? str(c, 'notebook_path')
const baseName = (path?: string) => path?.split(/[\\/]/).filter(Boolean).pop()

const listed = (words: string[]) =>
  words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * A run of tool calls in one line, as Claude Code's own view sums one up: each kind once, in the
 * order it first ran, with how many ("Ran 10 commands, used a tool"); files counted once each, and
 * read, edited or created alike when they all touched one file ("Read and edited cart.ts").
 * Three kinds at most; past that, two and how many calls more. Once the run is over (`closed`), a
 * last call that failed is said.
 */
export function summary(calls: Call[], closed = true): string {
  const kinds: string[] = []
  const byKind = new Map<string, Call[]>()
  for (const c of calls) {
    const k = kindOf(c.tool)
    if (!byKind.has(k)) { byKind.set(k, []); if (k !== 'other') kinds.push(k) }
    byKind.get(k)!.push(c)
  }
  if (byKind.has('other')) kinds.push('other')
  const distinct = (cs: Call[], key: (c: Call) => string | undefined) => new Set(cs.map((c, i) => key(c) ?? `#${i}`)).size
  const fileCalls = calls.filter(c => FILE_KINDS.includes(kindOf(c.tool)))
  const files = new Set(fileCalls.map(fileOf))
  const oneFile = fileCalls.length > 0 && files.size === 1 && [...files][0] ? baseName([...files][0]) : undefined
  const parts: { text: string; calls: number }[] = []
  let merged = false
  for (const k of kinds) {
    const cs = byKind.get(k)!
    if (oneFile && FILE_KINDS.includes(k)) {
      if (merged) continue
      merged = true
      const verbs = FILE_KINDS.filter(f => byKind.has(f)).sort((a, b) => kinds.indexOf(a) - kinds.indexOf(b)).map(f => PART[f]![0])
      parts.push({ text: `${listed(verbs)} ${oneFile}`, calls: fileCalls.length })
      continue
    }
    const [verb, what] = PART[k]!
    const n = FILE_KINDS.includes(k) || k === 'notebook' ? distinct(cs, fileOf) : k === 'fetch' ? distinct(cs, c => str(c, 'url')) : cs.length
    parts.push({ text: `${verb} ${what(n)}`, calls: cs.length })
  }
  let line: string
  if (parts.length > 3) {
    const more = parts.slice(2).reduce((t, p) => t + p.calls, 0)
    line = `${parts.slice(0, 2).map(p => p.text).join(', ')}, and ${count(more, '1 more tool', 'more tools')}`
  } else line = parts.map(p => p.text).join(', ')
  return capital(line) + (closed && calls.at(-1)?.failed ? ' (a tool failed)' : '')
}

// An MCP tool's own name, read as words: `mcp__github__create_issue` is "create issue".
const words = (tool: string) => {
  const name = tool.split('__').pop() ?? tool
  return name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim()
}

const host = (url?: string) => {
  if (!url) return undefined
  try { return new URL(url).hostname } catch { return url }
}

/** One call, as its line in an unfolded run reads: what it did, and to what (dim). */
export function step(c: Call): [string, string | undefined] {
  const k = kindOf(c.tool)
  const meta = c.meta
  switch (k) {
    case 'bash': return [str(c, 'description') || str(c, 'command') || meta || 'Ran a command', undefined]
    case 'read': return ['Read', baseName(fileOf(c)) ?? meta]
    case 'write': return ['Created', baseName(fileOf(c)) ?? meta]
    case 'edit': case 'notebook': return ['Edited', baseName(fileOf(c)) ?? meta]
    case 'grep': return ['Searched code', str(c, 'pattern') ?? meta]
    case 'glob': return ['Found files', str(c, 'pattern') ?? meta]
    case 'web': return ['Searched the web', str(c, 'query') ?? meta]
    case 'fetch': return ['Fetched', host(str(c, 'url')) ?? meta]
    case 'agent': return ['Ran an agent', str(c, 'description') ?? meta]
    case 'todo': return ['Updated todos', undefined]
  }
  if (c.tool === 'Skill') return [`Ran skill: ${str(c, 'skill') ?? meta ?? ''}`.trim(), undefined]
  if (c.tool === 'ToolSearch') return ['Loaded tools', undefined]
  if (c.tool === 'SubagentHandback') return ['Handed back its report', undefined]
  if (c.tool === 'StructuredOutput') return ['Returned its result', undefined]
  if (c.tool.startsWith('mcp__')) return [capital(words(c.tool)), c.tool.split('__')[1]]
  const first = Object.values(c.input).find((v): v is string => typeof v === 'string')
  return [c.tool, meta ?? first?.split('\n')[0]]
}

// What a running call is doing, as Claude Code's own panel says it ("Running a command").
const RUNNING: Record<string, string> = {
  Bash: 'Running a command', BashTool: 'Running a command', PowerShell: 'Running a command',
  Read: 'Reading', Write: 'Creating', Edit: 'Editing', MultiEdit: 'Editing', NotebookEdit: 'Editing',
  Grep: 'Searching', Glob: 'Searching', LS: 'Listing', WebFetch: 'Fetching', WebSearch: 'Searching web',
  Agent: 'Running agent', Task: 'Running agent', Skill: 'Running skill', TodoWrite: 'Updating todos',
  ExitPlanMode: 'Proposing plan', Workflow: 'Running workflow', Monitor: 'Watching background command',
}

/** What a working agent is doing now: the call still waiting on its result, else thinking. */
export function activity(t: Transcript): string {
  const last = t.entries.at(-1)
  const pending = last?.kind === 'tools' ? last.calls.findLast(c => !c.done) : undefined
  if (!pending) return 'Thinking…'
  return `${RUNNING[pending.tool] ?? `Using ${words(pending.tool)}`}…`
}
