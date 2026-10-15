/**
 * API explorer, phase 4: the space's saved requests, shared with its team like statuses and views, and
 * import/export. Postman v2.1 and OpenAPI 3 (or Swagger 2) come in as saved requests; saved requests go
 * out as Postman v2.1, and the discovered endpoints as an OpenAPI 3 document. Auth never travels: headers
 * that carry it are dropped on import, and the secrets live per person in the encrypted secrets.
 */
import { app, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { parse as parseYaml } from 'yaml'
import { getStore } from '../../store'
import { getWorkspace } from '../workspaces'
import { discover } from './discover'
import type { ApiSavedRequest, Space } from '@shared/types'

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

function spaceOf(workspaceId: string): Space | undefined {
  const ws = getWorkspace(workspaceId)
  return getStore().get().spaces.find((x) => x.id === ws.spaceId)
}

/** The space's saved requests, or the app's own for a workspace outside a space. */
export function savedOf(workspaceId: string): ApiSavedRequest[] {
  const space = spaceOf(workspaceId)
  return (space ? space.apiCollection : getStore().get().settings.apiCollection) ?? []
}

function writeSaved(workspaceId: string, edit: (list: ApiSavedRequest[]) => ApiSavedRequest[]): void {
  const ws = getWorkspace(workspaceId)
  getStore().update((d) => {
    const target = d.spaces.find((x) => x.id === ws.spaceId) ?? d.settings
    const next = edit(target.apiCollection ?? [])
    target.apiCollection = next.length ? next : undefined
  })
}

/** Add or update one saved request. Auth headers typed into the request are not kept: the collection is shared. */
export function saveRequest(workspaceId: string, item: { id?: string; name: string; folder?: string; request: ApiSavedRequest['request'] }): ApiSavedRequest {
  const name = item.name.trim()
  if (!name) throw new Error('Give the request a name.')
  const { confirmed: _c, ...request } = item.request as ApiSavedRequest['request'] & { confirmed?: boolean }
  void _c
  const saved: ApiSavedRequest = {
    id: item.id ?? nanoid(8),
    name,
    ...(item.folder?.trim() ? { folder: item.folder.trim() } : {}),
    request: { ...request, method: request.method.toUpperCase(), headers: request.headers.filter(([k]) => k.trim() && !SECRET_HEADER.test(k.trim())) },
    updatedAt: new Date().toISOString()
  }
  writeSaved(workspaceId, (list) => (list.some((x) => x.id === saved.id) ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved]))
  return saved
}

export function renameSaved(workspaceId: string, id: string, name: string, folder?: string): void {
  if (!name.trim()) throw new Error('Give the request a name.')
  writeSaved(workspaceId, (list) => list.map((x) => (x.id === id ? { ...x, name: name.trim(), folder: folder?.trim() || undefined, updatedAt: new Date().toISOString() } : x)))
}

export function deleteSaved(workspaceId: string, id: string): void {
  writeSaved(workspaceId, (list) => list.filter((x) => x.id !== id))
}

// ---------- import ----------

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The path and query of a Postman URL, without its {{baseUrl}} or host. */
function postmanPath(url: unknown): string {
  const raw = typeof url === 'string' ? url : (str(obj(url).raw) ?? '')
  let rest = raw.trim().replace(/^\{\{[^}]+\}\}/, '')
  rest = rest.replace(/^[a-z]+:\/\/[^/?#]+/i, '')
  if (!rest && typeof url === 'object') {
    const u = obj(url)
    const path = Array.isArray(u.path) ? (u.path as unknown[]).map(String).join('/') : ''
    const query = Array.isArray(u.query) ? (u.query as Raw[]).filter((q) => !q.disabled).map((q) => `${q.key}=${q.value ?? ''}`).join('&') : ''
    rest = `/${path}${query ? `?${query}` : ''}`
  }
  return rest.startsWith('/') ? rest : `/${rest}`
}

function fromPostman(doc: Raw): Omit<ApiSavedRequest, 'id' | 'updatedAt'>[] {
  const out: Omit<ApiSavedRequest, 'id' | 'updatedAt'>[] = []
  const walk = (items: unknown, folder: string[]): void => {
    if (!Array.isArray(items)) return
    for (const it of items as Raw[]) {
      if (Array.isArray(it.item)) {
        walk(it.item, [...folder, String(it.name ?? 'Folder')])
        continue
      }
      const r = obj(it.request)
      const method = (str(r.method) ?? 'GET').toUpperCase()
      const headers = (Array.isArray(r.header) ? (r.header as Raw[]) : [])
        .filter((h) => !h.disabled && typeof h.key === 'string' && !SECRET_HEADER.test(h.key as string))
        .map((h) => [String(h.key), String(h.value ?? '')] as [string, string])
      const body = obj(r.body)
      out.push({ name: String(it.name ?? `${method} ${postmanPath(r.url)}`), ...(folder.length ? { folder: folder.join(' / ') } : {}), request: { method, path: postmanPath(r.url), headers, ...(body.mode === 'raw' && typeof body.raw === 'string' && body.raw ? { body: body.raw } : {}), env: 'workspace' } })
    }
  }
  walk(doc.item, [])
  return out
}

function fromOpenApi(doc: Raw): Omit<ApiSavedRequest, 'id' | 'updatedAt'>[] {
  const out: Omit<ApiSavedRequest, 'id' | 'updatedAt'>[] = []
  const basePath = typeof doc.swagger === 'string' ? (str(doc.basePath) ?? '') : ''
  for (const [p, ops] of Object.entries(obj(doc.paths))) {
    for (const [m, raw] of Object.entries(obj(ops))) {
      const method = m.toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) continue
      const op = obj(raw)
      const path = (basePath.replace(/\/+$/, '') + p).replace(/\{(\w+)\}/g, ':$1')
      const json = obj(obj(obj(op.requestBody).content)['application/json'])
      const example = json.example ?? Object.values(obj(json.examples)).map((e) => obj(e).value)[0]
      const body = example !== undefined ? JSON.stringify(example, null, 2) : BODY_METHODS.includes(method) && op.requestBody ? '{}' : undefined
      const tag = Array.isArray(op.tags) ? String(op.tags[0] ?? '') : ''
      out.push({ name: str(op.summary) ?? str(op.operationId) ?? `${method} ${path}`, ...(tag ? { folder: tag } : {}), request: { method, path, headers: [], ...(body ? { body } : {}), env: 'workspace' } })
    }
  }
  return out
}

/** Pick a Postman or OpenAPI file and add its requests to the collection; ones already saved are skipped. */
export async function importFile(workspaceId: string, file?: string): Promise<{ added: number; skipped: number; format: string } | null> {
  let path = file
  if (!path) {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], title: 'Import a Postman collection or an OpenAPI file', filters: [{ name: 'Postman or OpenAPI', extensions: ['json', 'yaml', 'yml'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    path = r.filePaths[0]
  }
  const text = readFileSync(path, 'utf8')
  let doc: Raw
  try {
    doc = obj(/\.ya?ml$/i.test(path) ? parseYaml(text) : JSON.parse(text))
  } catch {
    throw new Error('That file is not valid JSON or YAML.')
  }
  const isOpenApi = typeof doc.openapi === 'string' || typeof doc.swagger === 'string'
  const isPostman = Array.isArray(doc.item) && (/postman/i.test(String(obj(doc.info).schema ?? '')) || Boolean(obj(doc.info).name))
  if (!isOpenApi && !isPostman) throw new Error('Sinfonie reads Postman v2.1 collections and OpenAPI 3 or Swagger 2 files. This file is neither.')
  const items = isOpenApi ? fromOpenApi(doc) : fromPostman(doc)
  const keyOf = (x: Pick<ApiSavedRequest, 'name' | 'folder' | 'request'>) => `${x.folder ?? ''}|${x.name}|${x.request.method}|${x.request.path}`
  const have = new Set(savedOf(workspaceId).map(keyOf))
  const now = new Date().toISOString()
  const fresh = items.filter((x) => !have.has(keyOf(x))).map((x) => ({ ...x, id: nanoid(8), updatedAt: now }))
  writeSaved(workspaceId, (list) => [...list, ...fresh])
  return { added: fresh.length, skipped: items.length - fresh.length, format: isOpenApi ? 'OpenAPI' : 'Postman' }
}

// ---------- export ----------

const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'api'

async function saveAs(title: string, name: string, body: unknown): Promise<string | null> {
  const r = await dialog.showSaveDialog({ title, defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (r.canceled || !r.filePath) return null
  writeFileSync(r.filePath, JSON.stringify(body, null, 2))
  return r.filePath
}

/** The saved requests as a Postman v2.1 collection; {{baseUrl}} is the workspace's app. */
export function toPostman(workspaceId: string): unknown {
  const ws = getWorkspace(workspaceId)
  const title = `${spaceOf(workspaceId)?.name ?? ws.name} API`
  const asItem = (x: ApiSavedRequest) => {
    const [p, q] = x.request.path.split('?')
    return {
      name: x.name,
      request: {
        method: x.request.method,
        header: x.request.headers.map(([key, value]) => ({ key, value })),
        ...(x.request.body ? { body: { mode: 'raw', raw: x.request.body, options: { raw: { language: 'json' } } } } : {}),
        url: { raw: `{{baseUrl}}${x.request.path}`, host: ['{{baseUrl}}'], path: p.split('/').filter(Boolean), ...(q ? { query: Array.from(new URLSearchParams(q)).map(([key, value]) => ({ key, value })) } : {}) }
      }
    }
  }
  const root: unknown[] = []
  const folders = new Map<string, unknown[]>()
  for (const x of savedOf(workspaceId)) {
    if (!x.folder) root.push(asItem(x))
    else {
      if (!folders.has(x.folder)) folders.set(x.folder, [])
      folders.get(x.folder)!.push(asItem(x))
    }
  }
  return {
    info: { name: title, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [...Array.from(folders, ([name, item]) => ({ name, item })), ...root],
    variable: [{ key: 'baseUrl', value: ws.port ? `http://localhost:${ws.port}` : '' }]
  }
}

/** The discovered endpoints as an OpenAPI 3 document (paths, methods, summaries, path parameters). */
export async function toOpenApi(workspaceId: string): Promise<unknown> {
  const ws = getWorkspace(workspaceId)
  const d = await discover(workspaceId)
  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of d.endpoints) {
    const p = e.path.replace(/[:*](\w+)/g, '{$1}')
    const method = e.method === 'ANY' ? 'get' : e.method.toLowerCase()
    const params = Array.from(p.matchAll(/\{(\w+)\}/g)).map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }))
    paths[p] = paths[p] ?? {}
    if (paths[p][method]) continue
    paths[p][method] = {
      ...(e.summary ? { summary: e.summary } : {}),
      ...(e.group ? { tags: [e.group] } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(BODY_METHODS.includes(e.method) && e.method !== 'DELETE' ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { default: { description: 'Response' } },
      'x-sinfonie-source': e.source,
      ...(e.file ? { 'x-sinfonie-file': `${e.repoName}/${e.file.split('/').slice(-3).join('/')}${e.line ? `:${e.line}` : ''}` } : {})
    }
  }
  return { openapi: '3.0.3', info: { title: `${ws.name} API`, version: '1.0.0', description: 'Generated by Sinfonie from the code, OpenAPI files and the running app.' }, servers: ws.port ? [{ url: `http://localhost:${ws.port}` }] : [], paths }
}

export async function exportCollection(workspaceId: string): Promise<string | null> {
  return saveAs('Export saved requests (Postman)', `${fileSafe(getWorkspace(workspaceId).name)}.postman_collection.json`, toPostman(workspaceId))
}
export async function exportOpenApi(workspaceId: string): Promise<string | null> {
  return saveAs('Export endpoints (OpenAPI)', `${fileSafe(getWorkspace(workspaceId).name)}.openapi.json`, await toOpenApi(workspaceId))
}
