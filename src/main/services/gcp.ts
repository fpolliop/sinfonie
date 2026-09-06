/**
 * Google Cloud for Sinfonie. Uses the user's local gcloud login (no service accounts, no keys
 * stored by the app), a project per space or app-wide, and a read-only tool set: Cloud Logging,
 * Cloud Run services and revisions, Error Reporting, and any `list` / `describe` / `read` gcloud
 * command. Exposed to workspace sessions and to the on-call triage agent. Nothing here mutates
 * cloud resources; mutating verbs are refused before gcloud runs.
 */
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { z } from 'zod'
import { createSdkMcpServer, tool as sdkTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import { tool as aiTool, type ToolSet } from 'ai'
import { getStore } from '../store'
import type { GcpSettings, GcpStatus } from '@shared/types'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const MAX_OUT = 40_000

// ---------- gcloud binary and settings ----------

let binCache: string | null | undefined
export function gcloudBin(): string | null {
  if (binCache !== undefined) return binCache
  const candidates = [
    ...(process.env.PATH ?? '').split(':').map((p) => `${p}/gcloud`),
    '/opt/homebrew/bin/gcloud',
    '/usr/local/bin/gcloud',
    `${homedir()}/google-cloud-sdk/bin/gcloud`,
    '/opt/homebrew/share/google-cloud-sdk/bin/gcloud',
    '/usr/local/share/google-cloud-sdk/bin/gcloud'
  ]
  binCache = candidates.find((p) => p && existsSync(p)) ?? null
  return binCache
}

/** The space's project, else the app-wide one. Undefined when neither names a project. */
export function gcpFor(spaceId?: string): GcpSettings | undefined {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  const cfg = space?.gcp?.projectId ? space.gcp : settings.gcp
  return cfg?.projectId ? cfg : undefined
}

function run(args: string[], opts: { account?: string; project?: string; timeoutMs?: number; json?: boolean } = {}): Promise<string> {
  const bin = gcloudBin()
  if (!bin) return Promise.reject(new Error('gcloud is not installed. Install the Google Cloud SDK (brew install --cask google-cloud-sdk) and sign in with `gcloud auth login`.'))
  const full = [...args]
  if (opts.json !== false && !full.some((a) => a.startsWith('--format'))) full.push('--format=json')
  if (opts.project) full.push(`--project=${opts.project}`)
  if (opts.account) full.push(`--account=${opts.account}`)
  full.push('--quiet')
  return new Promise((resolve, reject) => {
    execFile(bin, full, { env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message)
          .split('\n')
          .filter((l) => l.trim() && !/^Updates are available|^To update|^\$ gcloud components/.test(l))
          .slice(-4)
          .join(' ')
        reject(new Error(tail || 'gcloud failed'))
      } else resolve(String(stdout))
    })
  })
}

// ---------- status, projects, login ----------

let statusCache: { at: number; value: GcpStatus } | null = null
export async function status(force = false): Promise<GcpStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value
  const bin = gcloudBin()
  let value: GcpStatus
  if (!bin) value = { installed: false, accounts: [] }
  else {
    try {
      const [version, accountsRaw, project] = await Promise.all([
        run(['version']).then((s) => (JSON.parse(s) as Record<string, string>)['Google Cloud SDK']).catch(() => undefined),
        run(['auth', 'list']),
        run(['config', 'get-value', 'project'], { json: false }).then((s) => s.trim()).catch(() => '')
      ])
      const accounts = (JSON.parse(accountsRaw) as { account: string; status?: string }[]).map((a) => ({ account: a.account, active: a.status === 'ACTIVE' }))
      value = { installed: true, path: bin, version, accounts, defaultProject: project && project !== '(unset)' ? project : undefined }
    } catch (err) {
      value = { installed: true, path: bin, accounts: [], error: errText(err) }
    }
  }
  statusCache = { at: Date.now(), value }
  return value
}

const projectsCache = new Map<string, { at: number; value: { projectId: string; name: string }[] }>()
export async function projects(account?: string, force = false): Promise<{ projectId: string; name: string }[]> {
  const key = account ?? ''
  const hit = projectsCache.get(key)
  if (!force && hit && Date.now() - hit.at < 10 * 60_000) return hit.value
  const raw = await run(['projects', 'list'], { account, timeoutMs: 90_000 })
  const value = (JSON.parse(raw) as { projectId: string; name?: string }[]).map((p) => ({ projectId: p.projectId, name: p.name ?? p.projectId })).sort((a, b) => a.projectId.localeCompare(b.projectId))
  projectsCache.set(key, { at: Date.now(), value })
  return value
}

/** `gcloud auth login --brief`: opens the browser, completes on the localhost callback, no terminal needed. */
export function login(): Promise<GcpStatus> {
  const bin = gcloudBin()
  if (!bin) return Promise.reject(new Error('gcloud is not installed. Install the Google Cloud SDK first (brew install --cask google-cloud-sdk).'))
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['auth', 'login', '--brief', '--quiet'], { env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    const timer = setTimeout(() => child.kill(), 5 * 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      statusCache = null
      projectsCache.clear()
      if (code === 0) void status(true).then(resolve, reject)
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `gcloud auth login exited with ${code}`))
    })
  })
}

async function accessToken(account?: string): Promise<string> {
  return (await run(['auth', 'print-access-token'], { account, json: false })).trim()
}

// ---------- helpers ----------

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s)
function finish(text: string): string {
  return text.length > MAX_OUT ? text.slice(0, MAX_OUT) + `\n… output cut at ${MAX_OUT} characters; narrow the query.` : text
}
const SECRET_KEY = /secret|token|password|passwd|private|credential|api[_-]?key|signing|salt/i

type Json = Record<string, unknown>
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Json)[k] : undefined), o)

function compactLog(e: Json): Json {
  const jp = e.jsonPayload as Json | undefined
  const pp = e.protoPayload as Json | undefined
  const http = e.httpRequest as Json | undefined
  const labels = (e.labels ?? {}) as Json
  const res = (get(e, 'resource.labels') ?? {}) as Json
  const msg = e.textPayload ?? jp?.message ?? jp?.msg ?? jp?.error ?? get(pp, 'status.message') ?? (jp ? JSON.stringify(jp) : undefined) ?? (pp ? `${String(pp.methodName ?? '')} ${String(get(pp, 'authenticationInfo.principalEmail') ?? '')}`.trim() : '')
  const out: Json = {
    ts: e.timestamp,
    sev: e.severity,
    svc: res.service_name ?? res.function_name ?? res.module_id ?? res.container_name ?? res.database_id ?? get(e, 'resource.type'),
    rev: res.revision_name,
    msg: clip(String(msg ?? ''), 700)
  }
  if (http) out.http = `${String(http.requestMethod ?? '')} ${String(http.status ?? '')} ${clip(String(http.requestUrl ?? ''), 160)} ${String(http.latency ?? '')}`.trim()
  const ids: Json = {}
  for (const k of ['correlationId', 'correlation_id', 'requestId', 'request_id', 'userId', 'user_id', 'sessionId'] as const) if (jp?.[k]) ids[k] = jp[k]
  if (Object.keys(ids).length) out.ids = ids
  if (e.trace) out.trace = String(e.trace).split('/').pop()
  if (jp?.stack) out.stack = clip(String(jp.stack), 600)
  if (Object.keys(labels).length) out.labels = Object.fromEntries(Object.entries(labels).filter(([k]) => !k.startsWith('goog-')).slice(0, 6))
  out.insertId = e.insertId
  return out
}

function compactService(s: Json): Json {
  const tmpl = (s.spec as Json | undefined)?.template as Json | undefined
  const ann = ((tmpl?.metadata as Json | undefined)?.annotations ?? {}) as Json
  const spec = (tmpl?.spec ?? {}) as Json
  const c = (((spec.containers as Json[] | undefined) ?? [])[0] ?? {}) as Json
  const env = ((c.env as Json[] | undefined) ?? []).map((v) => ({ name: String(v.name), value: v.valueFrom ? '<secret ref>' : SECRET_KEY.test(String(v.name)) ? '<redacted>' : clip(String(v.value ?? ''), 200) }))
  const conds = ((get(s, 'status.conditions') as Json[] | undefined) ?? []).map((k) => `${String(k.type)}=${String(k.status)}${k.message ? ` (${clip(String(k.message), 160)})` : ''}`)
  const topAnn = (get(s, 'metadata.annotations') as Json | undefined) ?? {}
  return {
    name: get(s, 'metadata.name'),
    region: ((get(s, 'metadata.labels') as Json | undefined) ?? {})['cloud.googleapis.com/location'],
    url: get(s, 'status.url'),
    latestReadyRevision: get(s, 'status.latestReadyRevisionName'),
    latestCreatedRevision: get(s, 'status.latestCreatedRevisionName'),
    traffic: ((get(s, 'status.traffic') as Json[] | undefined) ?? []).map((t) => `${String(t.percent)}% → ${String(t.revisionName ?? (t.latestRevision ? 'latest' : ''))}`),
    image: c.image,
    scaling: { minInstances: ann['autoscaling.knative.dev/minScale'] ?? '0', maxInstances: ann['autoscaling.knative.dev/maxScale'] ?? 'default', concurrency: spec.containerConcurrency, timeoutSeconds: spec.timeoutSeconds, cpuThrottling: ann['run.googleapis.com/cpu-throttling'], startupBoost: ann['run.googleapis.com/startup-cpu-boost'] },
    resources: (c.resources as Json | undefined)?.limits,
    network: { vpcConnector: ann['run.googleapis.com/vpc-access-connector'], vpcEgress: ann['run.googleapis.com/vpc-access-egress'], ingress: topAnn['run.googleapis.com/ingress'] },
    serviceAccount: spec.serviceAccountName,
    env,
    conditions: conds,
    lastModifier: topAnn['serving.knative.dev/lastModifier'],
    updated: get(s, 'status.conditions.0.lastTransitionTime')
  }
}

function compactRevision(r: Json): Json {
  const c = (((get(r, 'spec.containers') as Json[] | undefined) ?? [])[0] ?? {}) as Json
  const conds = ((get(r, 'status.conditions') as Json[] | undefined) ?? []).map((k) => `${String(k.type)}=${String(k.status)}${k.message ? ` (${clip(String(k.message), 120)})` : ''}`)
  return { name: get(r, 'metadata.name'), created: get(r, 'metadata.creationTimestamp'), image: c.image, active: ((get(r, 'metadata.labels') as Json | undefined) ?? {})['serving.knative.dev/active'] ?? undefined, conditions: conds }
}

const READ_VERBS = new Set(['list', 'describe', 'read', 'get-iam-policy', 'get-effective-firewalls', 'get-health', 'get-value', 'get-server-config', 'get-ancestors', 'list-instances', 'list-users', 'operations', 'versions'])
const DENY_TOKENS = new Set(['create', 'update', 'delete', 'set', 'deploy', 'execute', 'add', 'remove', 'enable', 'disable', 'ssh', 'scp', 'start', 'stop', 'restart', 'import', 'export', 'copy', 'cp', 'apply', 'auth', 'config', 'login', 'init', 'patch', 'resize', 'replace', 'submit', 'cancel', 'promote', 'rollback', 'migrate', 'reset', 'suspend', 'resume', 'attach', 'detach', 'move', 'undelete', 'invalidate', 'print-access-token', 'print-identity-token', 'activate-service-account', 'revoke', 'components', 'interactive', 'tail', 'connect', 'proxy', 'run-job', 'trigger', 'publish', 'ack', 'pull', 'push', 'rm', 'mv', 'rsync', 'sign-url', 'set-iam-policy', 'add-iam-policy-binding', 'remove-iam-policy-binding', 'add-tags', 'remove-tags', 'reboot', 'simulate-maintenance-event', 'send-diagnostic-interrupt', 'reset-windows-password', 'os-login', 'clone', 'failover', 'restore', 'restore-backup', 'promote-replica', 'add-config', 'edit'])

/** True when every token is a read: a known read verb is present and no mutating token is. */
export function isReadOnlyGcloud(args: string[]): { ok: true } | { ok: false; why: string } {
  const toks = args.map((a) => a.trim()).filter(Boolean)
  if (toks[0] === 'gcloud') toks.shift()
  if (!toks.length || toks[0].startsWith('-')) return { ok: false, why: 'give the gcloud command words, e.g. ["run", "services", "list"]' }
  for (const t of toks) {
    const word = t.startsWith('--') ? t.slice(2).split('=')[0] : t
    if (DENY_TOKENS.has(word)) return { ok: false, why: `"${t}" is not a read-only operation; Sinfonie only runs list / describe / read commands` }
    if (/^--(command|container-command|args|format|impersonate-service-account|configuration|account|project)\b/.test(t)) return { ok: false, why: `${t} is not allowed here` }
  }
  if (!toks.some((t) => READ_VERBS.has(t))) return { ok: false, why: 'only list / describe / read style commands are allowed (no read verb found)' }
  return { ok: true }
}

// ---------- tool definitions ----------

export interface Def {
  name: string
  description: string
  shape: z.ZodRawShape
  run: (spaceId: string | undefined, args: Record<string, unknown>) => Promise<string>
}

function cfgOrThrow(spaceId: string | undefined): GcpSettings {
  const cfg = gcpFor(spaceId)
  if (!cfg) throw new Error('No Google Cloud project is configured for this space. Set one under Settings → Integrations → Google Cloud.')
  return cfg
}

const DEFS: Def[] = [
  {
    name: 'gcp_logs',
    description:
      'Query Cloud Logging (read-only) with a Logging filter and return compact entries (timestamp, severity, service, revision, message, http, correlation ids, trace). Typical filters: resource.type="cloud_run_revision" resource.labels.service_name="spotted-api" severity>=ERROR; textPayload:"Failed to emit"; jsonPayload.correlationId="…"; insertId="…"; trace="projects/P/traces/T". Combine with AND / OR / NOT. Use freshness for the window (e.g. 2h, 7d) rather than timestamp clauses when you can.',
    shape: {
      filter: z.string().describe('Cloud Logging filter expression'),
      freshness: z.string().optional().describe('Look-back window like 30m, 6h, 2d, 7d. Default 24h.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max entries, default 50'),
      order: z.enum(['desc', 'asc']).optional().describe('Newest first (default) or oldest first')
    },
    run: async (spaceId, i) => {
      const cfg = cfgOrThrow(spaceId)
      const raw = await run(['logging', 'read', String(i.filter), `--limit=${Number(i.limit ?? 50)}`, `--freshness=${String(i.freshness ?? '24h')}`, `--order=${String(i.order ?? 'desc')}`], { project: cfg.projectId, account: cfg.account, timeoutMs: 120_000 })
      const entries = (JSON.parse(raw || '[]') as Json[]).map(compactLog)
      if (!entries.length) return `No entries in the last ${String(i.freshness ?? '24h')} for: ${String(i.filter)}`
      return finish(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (project ${cfg.projectId}, last ${String(i.freshness ?? '24h')}, ${String(i.order ?? 'desc')}):\n` + entries.map((e) => JSON.stringify(e)).join('\n'))
    }
  },
  {
    name: 'gcp_cloud_run_services',
    description: 'List Cloud Run services in the project (all regions unless one is given): name, region, URL, latest revisions, traffic split, image, scaling and readiness.',
    shape: { region: z.string().optional().describe('Region like us-central1; default all regions') },
    run: async (spaceId, i) => {
      const cfg = cfgOrThrow(spaceId)
      const args = ['run', 'services', 'list', '--platform=managed']
      if (i.region) args.push(`--region=${String(i.region)}`)
      const raw = await run(args, { project: cfg.projectId, account: cfg.account, timeoutMs: 90_000 })
      const list = (JSON.parse(raw || '[]') as Json[]).map(compactService).map((s) => ({ name: s.name, region: s.region, url: s.url, latestReadyRevision: s.latestReadyRevision, traffic: s.traffic, image: s.image, scaling: s.scaling, conditions: s.conditions }))
      return finish(list.length ? list.map((s) => JSON.stringify(s)).join('\n') : `No Cloud Run services in ${cfg.projectId}.`)
    }
  },
  {
    name: 'gcp_cloud_run_service',
    description: 'Describe one Cloud Run service: image, env (secret values redacted), min/max instances, concurrency, timeout, CPU/memory, VPC connector and egress, ingress, service account, traffic and conditions.',
    shape: { service: z.string(), region: z.string().optional().describe('Region; default the configured region or us-central1') },
    run: async (spaceId, i) => {
      const cfg = cfgOrThrow(spaceId)
      const raw = await run(['run', 'services', 'describe', String(i.service), '--platform=managed', `--region=${String(i.region ?? cfg.region ?? 'us-central1')}`], { project: cfg.projectId, account: cfg.account })
      return finish(JSON.stringify(compactService(JSON.parse(raw) as Json), null, 1))
    }
  },
  {
    name: 'gcp_cloud_run_revisions',
    description: 'Recent revisions of a Cloud Run service (newest first): name, created, image, active, conditions. Use it to see whether a deploy or a rollback lines up with an incident.',
    shape: { service: z.string(), region: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    run: async (spaceId, i) => {
      const cfg = cfgOrThrow(spaceId)
      const raw = await run(['run', 'revisions', 'list', `--service=${String(i.service)}`, '--platform=managed', `--region=${String(i.region ?? cfg.region ?? 'us-central1')}`, `--limit=${Number(i.limit ?? 10)}`, '--sort-by=~metadata.creationTimestamp'], { project: cfg.projectId, account: cfg.account })
      const list = (JSON.parse(raw || '[]') as Json[]).map(compactRevision)
      return finish(list.length ? list.map((r) => JSON.stringify(r)).join('\n') : 'No revisions.')
    }
  },
  {
    name: 'gcp_error_groups',
    description: 'Error Reporting groups for the project over a window: count, affected users, first/last seen, service, representative message. The quickest way to measure recurrence of an error and to see what else is failing.',
    shape: { hours: z.number().min(1).max(720).optional().describe('Window in hours: 1, 6, 24 (default), 168, 720'), service: z.string().optional().describe('Filter to one service name'), limit: z.number().int().min(1).max(100).optional() },
    run: async (spaceId, i) => {
      const cfg = cfgOrThrow(spaceId)
      const h = Number(i.hours ?? 24)
      const period = h <= 1 ? 'PERIOD_1_HOUR' : h <= 6 ? 'PERIOD_6_HOURS' : h <= 24 ? 'PERIOD_1_DAY' : h <= 168 ? 'PERIOD_1_WEEK' : 'PERIOD_30_DAYS'
      const token = await accessToken(cfg.account)
      const url = `https://clouderrorreporting.googleapis.com/v1beta1/projects/${cfg.projectId}/groupStats?timeRange.period=${period}&pageSize=${Number(i.limit ?? 25)}${i.service ? `&serviceFilter.service=${encodeURIComponent(String(i.service))}` : ''}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`Error Reporting API ${res.status}: ${clip(await res.text(), 300)}`)
      const j = (await res.json()) as { errorGroupStats?: Json[] }
      const groups = (j.errorGroupStats ?? []).map((g) => {
        const rep = (g.representative ?? {}) as Json
        const ctx = (rep.serviceContext ?? {}) as Json
        return { count: g.count, users: g.affectedUsersCount, firstSeen: g.firstSeenTime, lastSeen: g.lastSeenTime, service: `${String(ctx.service ?? '')}${ctx.version ? `@${String(ctx.version)}` : ''}`, message: clip(String(rep.message ?? '').split('\n')[0], 300), groupId: (g.group as Json | undefined)?.groupId, services: ((g.affectedServices as Json[] | undefined) ?? []).map((s) => String(s.service)).slice(0, 5) }
      })
      return finish(groups.length ? `${groups.length} error group${groups.length === 1 ? '' : 's'} in the last ${h}h (${cfg.projectId}):\n` + groups.map((g) => JSON.stringify(g)).join('\n') : `No error groups in the last ${h}h.`)
    }
  },
  {
    name: 'gcloud_read',
    description: 'Run any read-only gcloud command (list / describe / read style) against the project, as JSON. Examples: ["compute","forwarding-rules","list"], ["sql","instances","describe","main-db"], ["run","services","logs","read","spotted-worker","--region=us-central1","--limit=50"], ["container","clusters","list"], ["monitoring","policies","list"] (alpha/beta groups allowed). Mutating verbs are refused. Do not pass --project, --account or --format.',
    shape: { args: z.array(z.string()).min(1).describe('Command words and flags, without the leading "gcloud"') },
    run: async (spaceId, i) => {
      const cfg = cfgOrThrow(spaceId)
      const args = (i.args as string[]).map(String)
      const check = isReadOnlyGcloud(args)
      if (!check.ok) throw new Error(`Refused: ${check.why}.`)
      const raw = await run(args[0] === 'gcloud' ? args.slice(1) : args, { project: cfg.projectId, account: cfg.account, timeoutMs: 120_000 })
      return finish(raw.trim() || '(empty)')
    }
  }
]

export const SDK_ALLOWED = DEFS.map((d) => `mcp__gcp__${d.name}`)

export function promptFor(spaceId?: string): string {
  const cfg = gcpFor(spaceId)
  if (!cfg) return ''
  return `\nGoogle Cloud: project ${cfg.projectId}${cfg.region ? ` (default region ${cfg.region})` : ''} is available read-only through the gcp_* tools (Cloud Logging, Cloud Run services and revisions, Error Reporting) and gcloud_read for any list / describe command (Cloud SQL, load balancers, GKE, IAM…). Use them to measure recurrence, follow correlation ids, and check deploys and scaling before concluding; nothing there can change infrastructure.`
}

async function runForMcp(spaceId: string | undefined, d: Def, args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await d.run(spaceId, args) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${errText(err)}` }], isError: true }
  }
}

export function sdkServer(spaceId: string | undefined): NonNullable<Options['mcpServers']>[string] {
  return createSdkMcpServer({
    name: 'gcp',
    tools: DEFS.map((d) => sdkTool(d.name, d.description, d.shape, (args) => runForMcp(spaceId, d, args as Record<string, unknown>)))
  })
}

export function aiTools(spaceId: string | undefined): ToolSet {
  return Object.fromEntries(
    DEFS.map((d) => [
      d.name,
      aiTool<Record<string, unknown>, string, Record<string, never>>({
        description: d.description,
        inputSchema: z.object(d.shape) as unknown as z.ZodType<Record<string, unknown>>,
        execute: async (input) => {
          try {
            return await d.run(spaceId, input)
          } catch (err) {
            return `Error: ${errText(err)}`
          }
        }
      })
    ])
  )
}

/** A small end-to-end check for the settings page: newest error log line in the project. */
export async function test(spaceId: string | undefined): Promise<string> {
  const cfg = cfgOrThrow(spaceId)
  const raw = await run(['logging', 'read', 'severity>=ERROR', '--limit=1', '--freshness=7d'], { project: cfg.projectId, account: cfg.account, timeoutMs: 90_000 })
  const entries = (JSON.parse(raw || '[]') as Json[]).map(compactLog)
  if (!entries.length) return `Connected to ${cfg.projectId}. No ERROR entries in the last 7 days.`
  const e = entries[0]
  return `Connected to ${cfg.projectId}. Newest error (${String(e.ts)}, ${String(e.svc ?? '?')}): ${clip(String(e.msg), 200)}`
}
