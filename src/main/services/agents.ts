import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { nanoid } from 'nanoid'
import type { AgentSpec, AgentTemplate } from '@shared/types'
import { DEFAULT_CREW } from '@shared/types'
import { getStore } from '../store'

/**
 * The agent library: every agent the user can delegate to, @mention or schedule, one JSON
 * file each under userData/agents. Agents are global unless `scope` names a space. A space's
 * crew is the enabled agents visible to it, minus the ones it switched off, with its model
 * overrides applied. Older builds kept crews inside settings.agents and space.agents; those
 * are copied in once on first start.
 */

let cache: AgentSpec[] | null = null
let emitter: (agents: AgentSpec[]) => void = () => undefined

export function setAgentsEmitter(fn: typeof emitter): void {
  emitter = fn
}

function dir(): string {
  const d = join(app.getPath('userData'), 'agents')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
const file = (id: string): string => join(dir(), `${id}.json`)

const BUILTIN_IDS = new Set(DEFAULT_CREW.map((a) => a.id))

function readAll(): AgentSpec[] {
  const out: AgentSpec[] = []
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.json')) continue
    try {
      const a = JSON.parse(readFileSync(join(dir(), f), 'utf8')) as AgentSpec
      if (a && typeof a.id === 'string' && typeof a.name === 'string') out.push(a)
    } catch (err) {
      console.error(`Corrupt agent file ${f}`, err)
    }
  }
  return sort(out)
}

function sort(list: AgentSpec[]): AgentSpec[] {
  const rank = (a: AgentSpec): number => (a.source === 'builtin' ? 0 : 1)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function list(): AgentSpec[] {
  if (!cache) {
    cache = readAll()
    migrate()
  }
  return cache
}

export function get(id: string): AgentSpec | undefined {
  return list().find((a) => a.id === id)
}

function write(a: AgentSpec): void {
  writeFileSync(file(a.id), JSON.stringify(a, null, 2))
}

function commit(next: AgentSpec[]): AgentSpec[] {
  cache = sort(next)
  emitter(cache)
  return cache
}

/** Names must be unique among the agents a space can see (the orchestrator addresses them by name). */
function assertNameFree(spec: AgentSpec): void {
  const name = spec.name.trim()
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) throw new Error('Agent names use letters, digits, dashes and underscores only, e.g. "security-reviewer".')
  const clash = list().find((a) => a.id !== spec.id && a.name === name && (!a.scope || !spec.scope || a.scope === spec.scope))
  if (clash) throw new Error(`Another agent is already called "${name}"${clash.scope ? ' in that space' : ''}. Pick a different name.`)
}

/** Create or update. Returns the stored spec. */
export function save(input: AgentSpec): AgentSpec {
  const now = new Date().toISOString()
  const existing = input.id ? get(input.id) : undefined
  const spec: AgentSpec = {
    ...existing,
    ...input,
    id: input.id || nanoid(8),
    name: input.name.trim(),
    description: input.description.trim(),
    source: existing?.source ?? input.source ?? 'user',
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now
  }
  if (!spec.scope) delete spec.scope
  if (!spec.tools?.length) delete spec.tools
  if (!spec.disallowedTools?.length) delete spec.disallowedTools
  if (!spec.maxTurns) delete spec.maxTurns
  if (!spec.effort) delete spec.effort
  if (!spec.permissionMode) delete spec.permissionMode
  if (!spec.icon) delete spec.icon
  assertNameFree(spec)
  write(spec)
  commit([...list().filter((a) => a.id !== spec.id), spec])
  return spec
}

export function remove(id: string): void {
  const a = get(id)
  if (!a) return
  try {
    rmSync(file(id), { force: true })
  } catch {
    /* ignore */
  }
  commit(list().filter((x) => x.id !== id))
}

export function duplicate(id: string): AgentSpec {
  const a = get(id)
  if (!a) throw new Error(`No agent ${id}`)
  const taken = new Set(list().map((x) => x.name))
  let name = `${a.name}-copy`
  for (let i = 2; taken.has(name); i++) name = `${a.name}-copy-${i}`
  const { id: _id, createdAt: _c, updatedAt: _u, filePath: _f, ...rest } = a
  void _id
  void _c
  void _u
  void _f
  return save({ ...rest, id: '', name, source: 'user', enabled: true })
}

export function fromTemplate(t: AgentTemplate, scope?: string): AgentSpec {
  const taken = new Set(list().map((x) => x.name))
  let name = t.name
  for (let i = 2; taken.has(name); i++) name = `${t.name}-${i}`
  const { blurb: _b, ...rest } = t
  void _b
  return save({ ...rest, id: '', name, enabled: true, source: 'user', ...(scope ? { scope } : {}) })
}

/** The agents a space can see: global ones plus its own. */
export function visibleTo(spaceId?: string): AgentSpec[] {
  return list().filter((a) => !a.scope || a.scope === spaceId)
}

/** The crew an orchestrator in this space gets: enabled, not switched off by the space, models overridden. Empty when the space turned delegation off. */
export function crewFor(spaceId?: string): AgentSpec[] {
  const { spaces } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  if (space?.useCrew === false) return []
  const off = new Set(space?.crewDisabled ?? [])
  const models = space?.crewModels ?? {}
  return visibleTo(spaceId)
    .filter((a) => a.enabled && a.name.trim() && !off.has(a.id))
    .map((a) => (models[a.id] ? { ...a, model: models[a.id] } : a))
}

/** An agent by name among those a space can see, for @mentions. */
export function byName(name: string, spaceId?: string): AgentSpec | undefined {
  const n = name.toLowerCase()
  return visibleTo(spaceId).find((a) => a.name.toLowerCase() === n)
}

/** Put the built-in crew back: recreate missing built-ins, reset the existing ones' prompts and models. */
export function resetBuiltins(): AgentSpec[] {
  for (const d of DEFAULT_CREW) {
    const cur = get(d.id)
    save({ ...d, ...(cur ? { createdAt: cur.createdAt } : {}), source: 'builtin', enabled: true })
  }
  return list()
}

// ---------- one-time migration from settings.agents / space.agents ----------

function migrate(): void {
  const store = getStore()
  const { settings, spaces } = store.get()
  if (settings.agentLibraryMigratedAt) return
  const have = cache ?? []
  const next: AgentSpec[] = [...have]
  const now = new Date().toISOString()
  const add = (a: AgentSpec): void => {
    if (next.some((x) => x.id === a.id)) return
    next.push(a)
    write(a)
  }
  const globals = settings.agents?.length ? settings.agents : DEFAULT_CREW
  for (const a of globals) add({ ...a, source: BUILTIN_IDS.has(a.id) ? 'builtin' : 'user', createdAt: now, updatedAt: now })
  const globalIds = globals.map((a) => a.id)
  const disabledBySpace: Record<string, string[]> = {}
  const modelsBySpace: Record<string, Record<string, string>> = {}
  for (const s of spaces) {
    if (!s.agents) continue
    // The space's own crew replaced the app default before; keep that by switching the globals off for it.
    disabledBySpace[s.id] = globalIds
    modelsBySpace[s.id] = {}
    for (const a of s.agents) {
      // Same role as a global one (only model or effort differ): a per-space model override, not a copy.
      const sameRole = globals.find((g) => g.id === a.id && g.name === a.name && g.prompt === a.prompt && g.description === a.description && JSON.stringify(g.tools ?? []) === JSON.stringify(a.tools ?? []))
      if (sameRole) {
        disabledBySpace[s.id] = disabledBySpace[s.id].filter((id) => id !== a.id)
        if (!a.enabled) disabledBySpace[s.id].push(a.id)
        if (a.model !== sameRole.model) modelsBySpace[s.id][a.id] = a.model
        continue
      }
      add({ ...a, id: `${s.id}-${a.id}`.slice(0, 40), scope: s.id, source: 'user', createdAt: now, updatedAt: now })
    }
  }
  cache = sort(next)
  store.update((d) => {
    d.settings.agentLibraryMigratedAt = now
    for (const s of d.spaces) {
      if (disabledBySpace[s.id]?.length) s.crewDisabled = disabledBySpace[s.id]
      if (Object.keys(modelsBySpace[s.id] ?? {}).length) s.crewModels = modelsBySpace[s.id]
    }
  })
}

// ---------- Claude Code's .claude/agents/*.md format ----------

interface Frontmatter {
  name?: string
  description?: string
  tools?: string
  model?: string
  [k: string]: string | undefined
}

function parseMarkdown(text: string): { fm: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { fm: {}, body: text }
  const fm: Frontmatter = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    fm[key] = val
  }
  return { fm, body: m[2].trim() }
}

function agentFromMarkdown(path: string, scope?: string): AgentSpec | null {
  const { fm, body } = parseMarkdown(readFileSync(path, 'utf8'))
  const name = (fm.name ?? basename(path, '.md')).trim()
  if (!name || !body) return null
  const tools = fm.tools
    ? fm.tools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined
  const model = fm.model && fm.model !== 'inherit' ? fm.model : 'sonnet'
  return { id: '', name, description: fm.description ?? '', prompt: body, model, ...(tools?.length ? { tools } : {}), enabled: true, source: 'imported', filePath: path, ...(scope ? { scope } : {}) }
}

/** Find agent markdown files in a folder: the folder itself, or its .claude/agents subfolder. */
export function findAgentFiles(root: string): string[] {
  const candidates = [root, join(root, '.claude', 'agents'), join(root, 'agents')]
  const out: string[] = []
  for (const d of candidates) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) if (f.endsWith('.md')) out.push(join(d, f))
    if (out.length) break
  }
  return out
}

/** Import every agent file under a folder; existing agents with the same name (in scope) are updated in place. */
export function importDir(root: string, scope?: string): AgentSpec[] {
  const files = findAgentFiles(root)
  if (files.length === 0) throw new Error(`No agent files (.md with frontmatter) found in ${root} or its .claude/agents folder.`)
  const done: AgentSpec[] = []
  for (const f of files) {
    const parsed = agentFromMarkdown(f, scope)
    if (!parsed) continue
    const existing = byName(parsed.name, scope)
    done.push(save({ ...parsed, id: existing?.id ?? '', ...(existing ? { source: existing.source, enabled: existing.enabled } : {}) }))
  }
  return done
}

/** Write one agent as a Claude Code agent file. Returns the path. */
export function exportTo(id: string, dirPath: string): string {
  const a = get(id)
  if (!a) throw new Error(`No agent ${id}`)
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
  const path = join(dirPath, `${a.name}.md`)
  writeFileSync(path, toMarkdown(a))
  return path
}

export function toMarkdown(a: AgentSpec): string {
  const q = (s: string): string => (/[:#"'\n]/.test(s) ? JSON.stringify(s) : s)
  const lines = ['---', `name: ${a.name}`, `description: ${q(a.description)}`]
  if (a.tools?.length) lines.push(`tools: ${a.tools.join(', ')}`)
  lines.push(`model: ${a.model}`)
  lines.push('---', '', a.prompt.trim(), '')
  return lines.join('\n')
}
