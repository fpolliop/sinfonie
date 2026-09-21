/**
 * Actions from generated views that run in main (git and GitHub). The renderer asks for confirmation
 * first; the tier comes from the catalog and a confirm/outward action without `confirmed` is refused.
 */
import * as git from '../git'
import * as github from '../github'
import * as workspaces from '../workspaces'
import { ACTIONS } from '@shared/views/catalog'
import { invalidate } from './data'

interface ActionHost {
  createPr: (workspaceId: string, repoId: string, title: string, body: string, draft: boolean) => Promise<string>
}
let host: ActionHost | null = null
export function setActionHost(h: ActionHost): void {
  host = h
}

const MAIN_ACTIONS = ['mergePr', 'pushAll', 'rebaseAll', 'openPrsAll'] as const
export type MainAction = (typeof MAIN_ACTIONS)[number]
export const isMainAction = (name: string): name is MainAction => (MAIN_ACTIONS as readonly string[]).includes(name)

const msg = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0] : String(err))

async function pushAll(workspaceId: string): Promise<string> {
  const ws = workspaces.getWorkspace(workspaceId)
  const out: string[] = []
  for (const r of ws.repos) {
    try {
      const { count, hasUpstream } = await git.unpushedCount(r.worktreePath, r.baseBranch)
      if (!count && hasUpstream) {
        out.push(`${r.repoName}: nothing to push`)
        continue
      }
      await git.push(r.worktreePath)
      out.push(`${r.repoName}: pushed ${count} commit(s)`)
    } catch (err) {
      out.push(`${r.repoName}: push failed (${msg(err)})`)
    }
  }
  return out.join('\n') || 'No repositories in this workspace.'
}

async function rebaseAll(workspaceId: string): Promise<string> {
  const ws = workspaces.getWorkspace(workspaceId)
  const out: string[] = []
  for (const r of ws.repos) {
    const g = git.git(r.worktreePath)
    try {
      const st = await g.status()
      if (!st.isClean()) {
        out.push(`${r.repoName}: skipped, ${st.files.length} uncommitted file(s)`)
        continue
      }
      await g.fetch('origin', r.baseBranch)
      const before = (await g.revparse(['HEAD'])).trim()
      await g.rebase([`origin/${r.baseBranch}`])
      const after = (await g.revparse(['HEAD'])).trim()
      out.push(`${r.repoName}: ${before === after ? 'already up to date' : `rebased on origin/${r.baseBranch}`}`)
    } catch (err) {
      await g.rebase(['--abort']).catch(() => undefined)
      out.push(`${r.repoName}: conflicts rebasing on origin/${r.baseBranch}, left as it was (${msg(err)})`)
    }
  }
  return out.join('\n') || 'No repositories in this workspace.'
}

async function openPrsAll(workspaceId: string, draft: boolean): Promise<string> {
  if (!host) throw new Error('views host not wired')
  const ws = workspaces.getWorkspace(workspaceId)
  const out: string[] = []
  for (const r of ws.repos) {
    try {
      const existing = await github.prSummary(r.worktreePath, r.branch)
      if (existing && existing.state === 'OPEN') {
        out.push(`${r.repoName}: already has #${existing.number}`)
        continue
      }
      const ahead = await git.git(r.worktreePath).raw(['rev-list', '--count', `origin/${r.baseBranch}..HEAD`]).then((s) => Number(s.trim()) || 0).catch(() => 0)
      if (!ahead) {
        out.push(`${r.repoName}: no commits on the branch`)
        continue
      }
      const { count, hasUpstream } = await git.unpushedCount(r.worktreePath, r.baseBranch)
      if (!hasUpstream || count) await git.push(r.worktreePath)
      const url = await host.createPr(workspaceId, r.repoId, ws.jira ? `${ws.jira.key} ${ws.name}` : ws.linear ? `${ws.linear.identifier} ${ws.name}` : ws.name, '', draft)
      out.push(`${r.repoName}: ${url.split('\n').pop()}`)
    } catch (err) {
      out.push(`${r.repoName}: failed (${msg(err)})`)
    }
  }
  return out.join('\n') || 'No repositories in this workspace.'
}

export async function run(name: string, params: Record<string, unknown>, confirmed: boolean): Promise<string> {
  const def = ACTIONS[name as keyof typeof ACTIONS]
  if (!def || !isMainAction(name)) throw new Error(`Unknown action ${name}`)
  if (def.tier !== 'navigate' && !confirmed) throw new Error(`${name} needs the user's confirmation`)
  const p = def.params.parse(params) as { workspaceId: string; draft?: boolean; repo: string; number: number; method?: 'squash' | 'merge' | 'rebase' }
  try {
    switch (name) {
      case 'mergePr':
        return await github.mergePr(p.repo, p.number, p.method)
      case 'pushAll':
        return await pushAll(p.workspaceId)
      case 'rebaseAll':
        return await rebaseAll(p.workspaceId)
      case 'openPrsAll':
        return await openPrsAll(p.workspaceId, Boolean(p.draft))
    }
  } finally {
    invalidate()
  }
}
