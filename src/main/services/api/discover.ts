/**
 * API explorer, phase 1 (feedback #42): find a workspace's HTTP endpoints without anyone writing a
 * collection. In order of trust: OpenAPI/Swagger files in the repos, the running app's own OpenAPI
 * document (at the path its NestJS swagger setup names), then a code scan of NestJS controllers,
 * Next.js route handlers, FastAPI routes and Express/Fastify routes. Read-only: it reads files and,
 * when the workspace's app answers on its port, asks it for its spec.
 */
import { readFileSync, statSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import fg from 'fast-glob'
import { parse as parseYaml } from 'yaml'
import { getWorkspace } from '../workspaces'
import type { ApiDiscovery, ApiEndpoint, WorkspaceRepo } from '@shared/types'

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/.turbo/**', '**/out/**']
const MAX_FILE = 1024 * 1024
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']
const RANK: Record<ApiEndpoint['source'], number> = { openapi: 0, running: 1, nestjs: 2, nextjs: 2, fastapi: 2, express: 3 }

function read(file: string): string | null {
  try {
    if (statSync(file).size > MAX_FILE) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
/** Read many files without blocking the main process: async, a few dozen at a time. */
async function readAll(files: string[], concurrency = 48): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const f = files[next++]
      try {
        if ((await stat(f)).size <= MAX_FILE) out.set(f, await readFile(f, 'utf8'))
      } catch {
        /* unreadable: skip */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  return out
}
const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length
const join2 = (...parts: string[]): string => ('/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')).replace(/\/+/g, '/')

/** The nearest folder with its own package.json / pyproject.toml, relative to the repo ('' for the root). */
function serviceOf(root: string, file: string, cache: Map<string, string>): string {
  let dir = dirname(file)
  const seen: string[] = []
  while (dir.startsWith(root)) {
    const hit = cache.get(dir)
    if (hit !== undefined) {
      for (const d of seen) cache.set(d, hit)
      return hit
    }
    seen.push(dir)
    if (dir !== root && (fileExists(join(dir, 'package.json')) || fileExists(join(dir, 'pyproject.toml')))) {
      const rel = relative(root, dir).split(sep).join('/')
      for (const d of seen) cache.set(d, rel)
      return rel
    }
    if (dir === root) break
    dir = dirname(dir)
  }
  for (const d of seen) cache.set(d, '')
  return ''
}
function fileExists(f: string): boolean {
  try {
    return statSync(f).isFile()
  } catch {
    return false
  }
}

// ---------- OpenAPI ----------

function fromSpec(spec: unknown, base: Omit<ApiEndpoint, 'id' | 'method' | 'path' | 'source'>, source: 'openapi' | 'running'): ApiEndpoint[] {
  if (!spec || typeof spec !== 'object') return []
  const s = spec as { openapi?: string; swagger?: string; basePath?: string; paths?: Record<string, Record<string, { summary?: string; operationId?: string; tags?: string[]; parameters?: { name?: string }[]; requestBody?: unknown }>> }
  if (!(s.openapi || s.swagger) || !s.paths) return []
  const prefix = s.swagger && s.basePath && s.basePath !== '/' ? s.basePath : ''
  const out: ApiEndpoint[] = []
  for (const [path, ops] of Object.entries(s.paths)) {
    for (const m of METHODS) {
      const op = ops?.[m]
      if (!op) continue
      const params = (op.parameters ?? []).map((p) => p?.name).filter((n): n is string => Boolean(n))
      out.push({ ...base, id: '', method: m.toUpperCase(), path: join2(prefix, path.replace(/\{([^}]+)\}/g, ':$1')), source, summary: op.summary || op.operationId, group: op.tags?.[0], params, hasBody: Boolean(op.requestBody) || ['post', 'put', 'patch'].includes(m) })
    }
  }
  return out
}

async function specFiles(root: string): Promise<string[]> {
  return fg(['**/{openapi,swagger}.{json,yaml,yml}', '**/*.openapi.{json,yaml,yml}', '**/openapi/*.{json,yaml,yml}'], { cwd: root, ignore: IGNORE, absolute: true, deep: 7, suppressErrors: true })
}
function parseSpec(file: string): unknown {
  const text = read(file)
  if (!text) return null
  try {
    return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
  } catch {
    return null
  }
}

/** Paths the running app may serve its spec at: what SwaggerModule.setup names in the code, then the usual ones. */
async function runningSpec(port: number, hints: string[]): Promise<{ url: string; spec: unknown } | null> {
  const candidates = Array.from(new Set([...hints.flatMap((h) => [`/${h}-json`, `/${h}/json`]), '/api-json', '/docs-json', '/swagger-json', '/api/docs-json', '/openapi.json', '/swagger.json', '/v3/api-docs', '/api/openapi.json', '/docs/openapi.json']))
  for (const path of candidates) {
    const url = `http://127.0.0.1:${port}${path}`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1200) })
      if (!res.ok) continue
      const spec = (await res.json()) as unknown
      if (spec && typeof spec === 'object' && ('openapi' in spec || 'swagger' in spec)) return { url, spec }
    } catch {
      // Nothing listening, or not JSON: if the first probe cannot connect, the app is not running at all.
      if (path === candidates[0]) return null
    }
  }
  return null
}

// ---------- code scans ----------

function scanNest(root: string, files: string[], services: Map<string, string>, repo: WorkspaceRepo, texts: Map<string, string>): ApiEndpoint[] {
  // A global prefix (app.setGlobalPrefix('api')) applies to every controller of that service.
  const prefixOf = new Map<string, string>()
  const out: ApiEndpoint[] = []
  for (const file of files) {
    const text = texts.get(file)
    if (!text || !/@Controller\s*\(/.test(text)) continue
    const service = serviceOf(root, file, services)
    if (!prefixOf.has(service)) {
      const mains = fg.sync(['src/main.ts', 'main.ts'], { cwd: service ? join(root, service) : root, absolute: true })
      const m = mains.map(read).find((t) => t && /setGlobalPrefix\s*\(/.test(t))
      prefixOf.set(service, m ? (/setGlobalPrefix\s*\(\s*['"`]([^'"`]*)/.exec(m)?.[1] ?? '') : '')
    }
    const ctrl = /@Controller\s*\(\s*(?:['"`]([^'"`]*)['"`]|\{[^}]*path\s*:\s*['"`]([^'"`]*)['"`][^}]*\}|([A-Z_][A-Za-z0-9_]*))?\s*\)/.exec(text)
    let ctrlPath = ctrl ? (ctrl[1] ?? ctrl[2] ?? '') : ''
    if (ctrl?.[3]) ctrlPath = constantValue(ctrl[3], file, text, texts) ?? `{${ctrl[3]}}`
    const className = /export\s+(?:default\s+)?class\s+(\w+)/.exec(text)?.[1]
    const re = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g
    let lastHandlerAt = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const path = join2(prefixOf.get(service) ?? '', ctrlPath, m[2] ?? '')
      // The handler is the first line after the decorators that is not itself a decorator.
      const from = m.index + m[0].length
      const after = text.slice(from, from + 1500)
      const h = /^\s*(?!@)(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_]\w*)\s*[(<]/m.exec(after)
      const handlerAt = h ? from + h.index : from
      // A swagger summary among this handler's own decorators (since the previous handler) reads better than its name.
      const decorators = text.slice(Math.max(lastHandlerAt, m.index - 800), handlerAt)
      const summary = /@ApiOperation\s*\(\s*\{[^}]*summary\s*:\s*['"`]([^'"`]+)['"`]/.exec(decorators)?.[1]
      lastHandlerAt = handlerAt
      out.push({ id: '', method: m[1] === 'All' ? 'ANY' : m[1].toUpperCase(), path, source: 'nestjs', repoId: repo.repoId, repoName: repo.repoName, service, file, line: lineOf(text, m.index), summary: summary ?? h?.[1], group: className, params: Array.from(path.matchAll(/:(\w+)/g)).map((x) => x[1]) })
    }
  }
  return out
}

/** A string constant's value: in the same file, or in a file of the same folder (where such constants usually live). */
function constantValue(name: string, file: string, text: string, texts: Map<string, string>): string | null {
  const re = new RegExp(`\\b${name}\\s*(?::[^=]+)?=\\s*['"\`]([^'"\`]*)['"\`]`)
  const own = re.exec(text)?.[1]
  if (own !== undefined) return own
  const dir = dirname(file)
  for (const [f, t] of texts) if (dirname(f) === dir && f !== file) {
    const v = re.exec(t)?.[1]
    if (v !== undefined) return v
  }
  for (const f of fg.sync(['*.ts'], { cwd: dir, absolute: true })) {
    if (texts.has(f)) continue
    const v = re.exec(read(f) ?? '')?.[1]
    if (v !== undefined) return v
  }
  return null
}

function nextRoutePath(rel: string, marker: 'app' | 'pages'): string | null {
  const parts = rel.split('/')
  const at = parts.lastIndexOf(marker)
  if (at < 0) return null
  const segs = parts.slice(at + 1)
  segs.pop() // the file itself
  const mapped = segs
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'))
    .map((s) => s.replace(/^\[\[\.\.\.(\w+)\]\]$/, '*$1?').replace(/^\[\.\.\.(\w+)\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1'))
  return join2(...mapped)
}

function scanNext(root: string, appRoutes: string[], pagesApi: string[], services: Map<string, string>, repo: WorkspaceRepo, texts: Map<string, string>): ApiEndpoint[] {
  const out: ApiEndpoint[] = []
  for (const file of appRoutes) {
    const text = texts.get(file)
    if (!text) continue
    const rel = relative(root, file).split(sep).join('/')
    const path = nextRoutePath(rel, 'app')
    if (!path) continue
    const service = serviceOf(root, file, services)
    const re = /export\s+(?:async\s+function|function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) out.push({ id: '', method: m[1], path, source: 'nextjs', repoId: repo.repoId, repoName: repo.repoName, service, file, line: lineOf(text, m.index), group: path.split('/').slice(0, 3).join('/') || '/', params: Array.from(path.matchAll(/:(\w+)/g)).map((x) => x[1]) })
  }
  for (const file of pagesApi) {
    const rel = relative(root, file).split(sep).join('/').replace(/\/index\.(ts|js|tsx|jsx)$/, '/x.$1')
    const routed = nextRoutePath(rel.replace(/\.(ts|js|tsx|jsx)$/, '/f'), 'pages')
    if (!routed) continue
    const service = serviceOf(root, file, services)
    const path = routed.replace(/\/x$/, '') || '/'
    out.push({ id: '', method: 'ANY', path, source: 'nextjs', repoId: repo.repoId, repoName: repo.repoName, service, file, line: 1, group: path.split('/').slice(0, 3).join('/'), params: Array.from(path.matchAll(/:(\w+)/g)).map((x) => x[1]) })
  }
  return out
}

function scanFastApi(root: string, files: string[], services: Map<string, string>, repo: WorkspaceRepo, texts: Map<string, string>): ApiEndpoint[] {
  const out: ApiEndpoint[] = []
  for (const file of files) {
    const text = texts.get(file)
    if (!text || !/fastapi/i.test(text)) continue
    const prefix = /APIRouter\s*\([^)]*prefix\s*=\s*['"]([^'"]*)['"]/.exec(text)?.[1] ?? ''
    const service = serviceOf(root, file, services)
    const re = /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]*)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const path = join2(prefix, m[3].replace(/\{([^}]+)\}/g, ':$1'))
      out.push({ id: '', method: m[2].toUpperCase(), path, source: 'fastapi', repoId: repo.repoId, repoName: repo.repoName, service, file, line: lineOf(text, m.index), group: relative(root, file).split(sep).slice(-2).join('/'), params: Array.from(path.matchAll(/:(\w+)/g)).map((x) => x[1]) })
    }
  }
  return out
}

function scanExpress(root: string, files: string[], services: Map<string, string>, repo: WorkspaceRepo, texts: Map<string, string>): ApiEndpoint[] {
  const out: ApiEndpoint[] = []
  for (const file of files) {
    const text = texts.get(file)
    // Only server code: files that use express, fastify or hono. HTTP clients (axios.get) never match these names.
    if (!text || !/from ['"](express|fastify|hono)['"]|require\(['"](express|fastify)['"]\)/.test(text)) continue
    const service = serviceOf(root, file, services)
    const re = /\b(app|router|server|fastify|route[rs]?)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`](\/[^'"`]*)['"`]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) out.push({ id: '', method: m[2] === 'all' ? 'ANY' : m[2].toUpperCase(), path: m[3], source: 'express', repoId: repo.repoId, repoName: repo.repoName, service, file, line: lineOf(text, m.index), group: relative(root, file).split(sep).slice(-2).join('/'), params: Array.from(m[3].matchAll(/:(\w+)/g)).map((x) => x[1]) })
  }
  return out
}

// ---------- the whole workspace ----------

const cache = new Map<string, { at: number; value: ApiDiscovery }>()

export async function discover(workspaceId: string, force = false): Promise<ApiDiscovery> {
  const hit = cache.get(workspaceId)
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.value
  const ws = getWorkspace(workspaceId)
  const all: ApiEndpoint[] = []
  const repos: ApiDiscovery['repos'] = []
  await Promise.all(ws.repos.map(async (repo) => {
    const root = repo.worktreePath
    const services = new Map<string, string>()
    const info: ApiDiscovery['repos'][number] = { repoId: repo.repoId, repoName: repo.repoName, sources: [], specFiles: [] }
    try {
      const found: ApiEndpoint[] = []
      for (const file of await specFiles(root)) {
        const eps = fromSpec(parseSpec(file), { repoId: repo.repoId, repoName: repo.repoName, service: serviceOf(root, file, services), file }, 'openapi')
        if (eps.length) {
          info.specFiles.push(relative(root, file))
          found.push(...eps)
        }
      }
      const code = await fg(['**/*.controller.ts', '**/app/**/route.{ts,js,tsx,jsx}', '**/pages/api/**/*.{ts,js,tsx,jsx}', '**/*.py', '**/*.{ts,js,mjs}'], { cwd: root, ignore: [...IGNORE, '**/*.d.ts', '**/*.spec.*', '**/*.test.*'], absolute: true, deep: 10, suppressErrors: true })
      const controllers = code.filter((f) => f.endsWith('.controller.ts'))
      const appRoutes = code.filter((f) => /\/app\/(.+\/)?route\.(ts|js|tsx|jsx)$/.test(f))
      const pagesApi = code.filter((f) => /\/pages\/api\//.test(f))
      const py = code.filter((f) => f.endsWith('.py')).slice(0, 4000)
      const special = new Set([...controllers, ...appRoutes, ...pagesApi])
      const js = code.filter((f) => /\.(ts|js|mjs)$/.test(f) && !special.has(f)).slice(0, 6000)
      const texts = await readAll([...special, ...py, ...js])
      found.push(...scanNest(root, controllers, services, repo, texts), ...scanNext(root, appRoutes, pagesApi, services, repo, texts), ...scanFastApi(root, py, services, repo, texts), ...scanExpress(root, js, services, repo, texts))
      // The running app's own spec, when it answers on the workspace's port.
      const hints = controllers.length ? fg.sync(['**/main.ts'], { cwd: root, ignore: IGNORE, absolute: true, deep: 6 }).flatMap((f) => Array.from((read(f) ?? '').matchAll(/SwaggerModule\.setup\s*\(\s*['"`]([^'"`]+)['"`]/g)).map((x) => x[1].replace(/^\/+/, ''))) : []
      if (ws.port && (controllers.length || hints.length || info.specFiles.length)) {
        const live = await runningSpec(ws.port, hints)
        if (live) {
          info.runningDoc = live.url
          found.push(...fromSpec(live.spec, { repoId: repo.repoId, repoName: repo.repoName, service: '' }, 'running'))
        }
      }
      info.sources = Array.from(new Set(found.map((e) => e.source)))
      all.push(...found)
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err)
    }
    repos.push(info)
  }))
  repos.sort((a, b) => ws.repos.findIndex((r) => r.repoId === a.repoId) - ws.repos.findIndex((r) => r.repoId === b.repoId))
  // One row per method and path within a service; the most trusted source wins, and code fills in the file.
  const byKey = new Map<string, ApiEndpoint>()
  for (const e of all.sort((a, b) => RANK[a.source] - RANK[b.source])) {
    const key = `${e.repoId}|${e.source === 'running' ? '' : e.service}|${e.method}|${e.path.replace(/:\w+/g, ':')}`
    const prev = byKey.get(key)
    if (!prev) byKey.set(key, e)
    else if (!prev.file && e.file) byKey.set(key, { ...prev, file: e.file, line: e.line })
  }
  const endpoints = Array.from(byKey.values())
    .sort((a, b) => a.repoName.localeCompare(b.repoName) || a.service.localeCompare(b.service) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .map((e, i) => ({ ...e, id: `${i}` }))
  const value: ApiDiscovery = { endpoints, repos, scannedAt: new Date().toISOString(), port: ws.port }
  cache.set(workspaceId, { at: Date.now(), value })
  return value
}
