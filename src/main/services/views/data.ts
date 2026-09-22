/**
 * Main-side data sources for generated views (GitHub, git, Jira/Linear). Results are cached briefly
 * per (source, params, context) so several views and refreshes do not hammer gh or the trackers.
 * Rows follow the field lists in @shared/views/sources; the renderer adds live agent state.
 */
import { getStore } from '../../store'
import * as git from '../git'
import * as github from '../github'
import * as jira from '../jira'
import * as linear from '../linear'
import { SOURCES, isSourceId } from '@shared/views/sources'
import type { ViewDataResult, ViewSourceBinding } from '@shared/views/types'
import type { Workspace } from '@shared/types'

export interface ViewContext {
  spaceId?: string
  workspaceId?: string
}

const cache = new Map<string, { at: number; value: Promise<unknown[]> }>()

export function ago(iso: string | undefined): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const liveWorkspaces = (): Workspace[] => getStore().get().workspaces.filter((w) => w.status !== 'archived')

/** The Sinfonie workspace working on this branch (in a repo of that name when we know it). */
function workspaceForBranch(branch: string, repoName?: string): string {
  const ws = liveWorkspaces()
  const exact = ws.find((w) => w.repos.some((r) => r.branch === branch && (!repoName || r.repoName === repoName)))
  return (exact ?? ws.find((w) => w.repos.some((r) => r.branch === branch)))?.id ?? ''
}

const size = (a: number, d: number): string => `+${a} −${d}`

async function myPrs(params: { owners?: string[]; limit?: number }): Promise<unknown[]> {
  const prs = await github.searchPrs('author:@me', params.owners, params.limit ?? 30)
  return prs.map((p) => {
    const review = p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : p.reviewDecision === 'REVIEW_REQUIRED' ? 'review' : 'none'
    const conflicts = p.mergeable === 'CONFLICTING'
    return {
      id: `${p.repo}#${p.number}`,
      repo: p.repo,
      repoName: p.repoName,
      number: p.number,
      title: p.title,
      url: p.url,
      branch: p.branch,
      draft: p.draft,
      ci: p.ci,
      review,
      reviewLabel: review === 'approved' ? 'Approved' : review === 'changes' ? 'Changes requested' : review === 'review' ? 'Review required' : '',
      mergeable: !p.draft && !conflicts && p.mergeable === 'MERGEABLE' && (p.ci === 'success' || p.ci === 'none') && (review === 'approved' || review === 'none'),
      conflicts,
      size: size(p.additions, p.deletions),
      updated: ago(p.updatedAt),
      workspaceId: workspaceForBranch(p.branch, p.repoName)
    }
  })
}

async function reviewQueue(params: { owners?: string[]; limit?: number }): Promise<unknown[]> {
  const prs = await github.searchPrs('review-requested:@me', params.owners, params.limit ?? 30)
  return prs.map((p) => ({ id: `${p.repo}#${p.number}`, repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author, ci: p.ci, size: size(p.additions, p.deletions), updated: ago(p.updatedAt) }))
}

async function branchStatus(ctx: ViewContext): Promise<unknown[]> {
  const ws = liveWorkspaces().find((w) => w.id === ctx.workspaceId)
  if (!ws) throw new Error('This view needs a workspace.')
  return Promise.all(
    ws.repos.map(async (r) => {
      const [st, pr] = await Promise.all([git.status(r.worktreePath).catch(() => null), github.prSummary(r.worktreePath, r.branch)])
      const ahead = st?.hasUpstream ? st.ahead : (await git.unpushedCount(r.worktreePath, r.baseBranch).catch(() => ({ count: 0 }))).count
      const dirty = st?.files.length ?? 0
      const bits = [ahead || st?.behind ? `↑${ahead} ↓${st?.behind ?? 0}` : '', dirty ? `${dirty} changed` : '', st && !st.hasUpstream ? 'not pushed' : ''].filter(Boolean)
      return {
        id: r.repoId,
        repo: r.repoName,
        branch: r.branch,
        base: r.baseBranch,
        ahead,
        behind: st?.behind ?? 0,
        dirty,
        pushed: Boolean(st?.hasUpstream),
        sync: st ? bits.join(' · ') || 'clean' : 'worktree missing',
        pr: pr ? `#${pr.number}` : '',
        prUrl: pr?.url ?? '',
        prState: pr?.state ?? '',
        ci: pr?.ci ?? 'none'
      }
    })
  )
}

function laneFor(status: string): 'todo' | 'doing' | 'review' | 'done' {
  const s = status.toLowerCase()
  if (/done|closed|resolved|released|complete|cancel|won't|duplicate/.test(s)) return 'done'
  if (/review|qa|test|verify|staging/.test(s)) return 'review'
  if (/progress|doing|develop|started|active/.test(s)) return 'doing'
  return 'todo'
}

async function tickets(params: { provider?: 'jira' | 'linear'; jql?: string; query?: string; spaceId?: string; limit?: number }, ctx: ViewContext): Promise<unknown[]> {
  const spaceId = params.spaceId ?? ctx.spaceId
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  const jiraConn = jira.connectionForSpace(spaceId)
  const jiraOn = Boolean(jiraConn ? space?.jira?.connected || space?.jira?.hasToken : settings.jira?.connected || settings.jira?.hasToken)
  const linearConn = linear.connectionForSpace(spaceId)
  const linearOn = Boolean(linearConn ? space?.linear?.connected : settings.linear?.connected)
  const provider = params.provider ?? (jiraOn ? 'jira' : linearOn ? 'linear' : undefined)
  if (!provider) throw new Error('Connect Jira or Linear (Settings → Integrations) to list tickets.')
  const ws = liveWorkspaces()
  type Raw = { key: string; title: string; url: string; status: string; providerId: string; assignee?: string; priority?: string }
  const raw: Raw[] =
    provider === 'jira'
      ? (params.jql ? await jira.searchJql(jiraConn, params.jql) : await jira.search(jiraConn, '')).map((i) => ({ key: i.key, title: i.summary, url: i.url, status: i.status, providerId: '', assignee: i.assignee, priority: i.priority }))
      : (await linear.search(linearConn, params.query ?? '')).map((i) => ({ key: i.identifier, title: i.title, url: i.url, status: i.state, providerId: i.id, assignee: i.assignee, priority: i.priority }))
  return raw.slice(0, params.limit ?? 60).map((t) => {
    const w = ws.find((x) => x.jira?.key === t.key || x.linear?.identifier === t.key)
    let lane = laneFor(t.status)
    if (w && lane === 'todo') lane = 'doing'
    if (w?.stage === 'in-review' && lane !== 'done') lane = 'review'
    if (w?.stage === 'done') lane = 'done'
    return {
      id: t.key,
      key: t.key,
      title: t.title,
      url: t.url,
      provider,
      providerId: t.providerId,
      status: t.status,
      lane,
      workspaceId: w?.id ?? '',
      workspaceState: w ? (w.stage === 'in-review' ? 'review' : 'idle') : 'none',
      agent: w ? (w.stage === 'in-review' ? 'pending' : 'none') : 'none',
      assignee: t.assignee ?? '',
      priority: t.priority ?? ''
    }
  })
}

async function fetchRows(b: ViewSourceBinding, ctx: ViewContext): Promise<unknown[]> {
  const p = (b.params ?? {}) as Record<string, never>
  switch (b.source) {
    case 'myPrs':
      return myPrs(p)
    case 'reviewQueue':
      return reviewQueue(p)
    case 'branchStatus':
      return branchStatus(ctx)
    case 'tickets':
      return tickets(p, ctx)
    default:
      throw new Error(`${b.source} is not a main-side source`)
  }
}

export async function data(b: ViewSourceBinding, ctx: ViewContext, force = false): Promise<ViewDataResult> {
  if (!isSourceId(b.source)) return { rows: [], error: `Unknown source ${b.source}`, fetchedAt: new Date().toISOString() }
  const ttl = Math.max(10, SOURCES[b.source].refreshSeconds / 2) * 1000
  const key = JSON.stringify([b.source, b.params ?? {}, b.source === 'branchStatus' ? ctx.workspaceId : b.source === 'tickets' ? ctx.spaceId : ''])
  let entry = cache.get(key)
  if (force || !entry || Date.now() - entry.at > ttl) {
    entry = { at: Date.now(), value: fetchRows(b, ctx) }
    cache.set(key, entry)
    entry.value.catch(() => cache.delete(key))
  }
  try {
    return { rows: await entry.value, fetchedAt: new Date(entry.at).toISOString() }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err), fetchedAt: new Date().toISOString() }
  }
}

/** Forget cached rows (after an action changed them). */
export function invalidate(source?: string): void {
  for (const k of cache.keys()) if (!source || k.startsWith(`["${source}"`)) cache.delete(k)
}
