/**
 * Renderer-side sources (attention, workspaces, usage) computed from the live stores, and the
 * enrichment of main-side rows with live agent state (running / waiting) by workspace id.
 */
import type { Incident, PermissionRequest, QuestionRequest, Space, UsageSnapshot, Workspace } from '@shared/types'
import { windowLabel } from '@/stores/usage'
import { stageLabel } from '@/lib/guided'

export interface LiveState {
  workspaces: Workspace[]
  spaces: Space[]
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  unseenDone: Record<string, true>
  busy: Record<string, boolean>
  usage: UsageSnapshot | null
  incidents: Incident[]
}

export function ago(iso: string | undefined): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function until(iso: string | undefined): string {
  if (!iso) return ''
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000))
  if (m < 60) return `resets in ${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `resets in ${h}h ${m % 60}m` : `resets in ${Math.round(h / 24)}d`
}

function permissionText(p: PermissionRequest): string {
  const cmd = typeof p.input.command === 'string' ? p.input.command : typeof p.input.file_path === 'string' ? p.input.file_path : ''
  return `Wants to use ${p.toolName}${cmd ? `: ${cmd.slice(0, 80)}` : ''}`
}

/** Live agent state of a workspace, as a Status dot value. */
export function agentState(live: LiveState, workspaceId: string): 'waiting' | 'running' | 'none' {
  if (!workspaceId) return 'none'
  if (live.permissions.some((p) => p.workspaceId === workspaceId) || live.questions.some((q) => q.workspaceId === workspaceId)) return 'waiting'
  return live.busy[workspaceId] ? 'running' : 'none'
}

export function liveRows(source: string, params: Record<string, unknown>, live: LiveState): unknown[] {
  const spaceName = (id?: string): string => live.spaces.find((s) => s.id === id)?.name ?? ''
  const wsById = new Map(live.workspaces.map((w) => [w.id, w]))
  const inSpace = (w: Workspace | undefined): boolean => !params.spaceId || w?.spaceId === params.spaceId
  switch (source) {
    case 'attention': {
      const rows: { id: string; workspaceId: string; workspace: string; space: string; kind: string; status: string; text: string }[] = []
      const add = (id: string, wid: string, kind: string, status: string, text: string): void => {
        const w = wsById.get(wid)
        if (!w || !inSpace(w)) return
        rows.push({ id, workspaceId: wid, workspace: w.name, space: spaceName(w.spaceId), kind, status, text })
      }
      for (const p of live.permissions) add(`p:${p.requestId}`, p.workspaceId, 'permission', 'waiting', permissionText(p))
      for (const q of live.questions) add(`q:${q.requestId}`, q.workspaceId, 'question', 'waiting', q.questions[0]?.question ?? 'Has a question')
      for (const w of live.workspaces) if (w.status === 'error') add(`e:${w.id}`, w.id, 'error', 'error', w.error ?? 'Something went wrong')
      for (const wid of Object.keys(live.unseenDone)) add(`d:${wid}`, wid, 'done', 'success', 'Finished; take a look')
      return rows
    }
    case 'workspaces': {
      const list = live.workspaces
        .filter((w) => w.status !== 'archived' && inSpace(w) && (!params.stage || w.stage === params.stage))
        .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
        .slice(0, typeof params.limit === 'number' ? params.limit : 50)
      return list.map((w) => ({
        id: w.id,
        name: w.name,
        space: spaceName(w.spaceId),
        spaceId: w.spaceId ?? '',
        stage: w.stage,
        stageLabel: stageLabel(w.stage, false),
        status: agentState(live, w.id),
        branch: w.repos[0]?.branch ?? '',
        repos: w.repos.map((r) => r.repoName).join(', '),
        repoCount: w.repos.length,
        ticket: w.jira?.key ?? w.linear?.identifier ?? '',
        lastActive: ago(w.lastMessageAt ?? w.createdAt)
      }))
    }
    case 'usage': {
      const rows: unknown[] = []
      for (const a of live.usage?.accounts ?? []) {
        for (const l of a.limits) {
          const percent = Math.round(l.utilization * 100)
          rows.push({ id: `${a.accountId}:${l.type}`, account: a.name, window: windowLabel(l.type), label: `${a.name} · ${windowLabel(l.type)}`, percent, resetsIn: until(l.resetsAt), status: percent >= 95 ? 'failure' : percent >= 80 ? 'pending' : 'success' })
        }
      }
      return rows
    }
    case 'incidents': {
      const open = params.open !== false
      const list = live.incidents
        .filter((i) => (!params.spaceId || i.spaceId === params.spaceId) && (!open || !['resolved', 'dismissed'].includes(i.status)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, typeof params.limit === 'number' ? params.limit : 50)
      return list.map((i) => ({
        id: i.id,
        title: i.title,
        channel: i.channelName,
        status: i.status,
        dot: i.status === 'triaging' ? 'running' : i.status === 'new' ? 'pending' : i.report?.needsHuman || i.proposals.some((p) => p.status === 'proposed') ? 'waiting' : i.status === 'resolved' ? 'success' : i.severity === 'critical' || i.severity === 'high' ? 'error' : 'pending',
        severity: i.severity ?? '',
        summary: i.report?.summary ?? '',
        cause: i.report?.likelyCause ?? '',
        needsHuman: Boolean(i.report?.needsHuman),
        proposals: i.proposals.filter((p) => p.status === 'proposed').length,
        triaged: Boolean(i.report),
        age: ago(i.createdAt),
        url: i.permalink ?? ''
      }))
    }
    default:
      return []
  }
}

/** Main rows that name a workspace get its live agent state. */
export function enrich(source: string, rows: unknown[], live: LiveState): unknown[] {
  if (source !== 'tickets' && source !== 'myPrs') return rows
  return rows.map((r) => {
    const row = r as Record<string, unknown>
    const wid = typeof row.workspaceId === 'string' ? row.workspaceId : ''
    const st = agentState(live, wid)
    if (source === 'tickets' && wid && st !== 'none') return { ...row, workspaceState: st, agent: st }
    return row
  })
}
