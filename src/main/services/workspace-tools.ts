/**
 * Tools that let the agent grow the workspace: list the space's repositories and attach one as a
 * worktree, after the user confirms in a question card. This is what makes "create the workspace
 * first, add repositories when the task needs them" work.
 */
import { z } from 'zod'
import { join } from 'path'
import { createSdkMcpServer, tool as sdkTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import { tool as aiTool, type ToolSet } from 'ai'
import { getStore } from '../store'
import { getWorkspace, addRepoToWorkspace } from './workspaces'
import { askQuestion } from './interaction'
import type { Repo, ScriptOutputEvent } from '@shared/types'

/** Setup-script output from a newly added repository goes to the Run pane, like any other script. */
let emitScript: (e: ScriptOutputEvent) => void = () => undefined
export function setScriptEmitter(fn: (e: ScriptOutputEvent) => void): void {
  emitScript = fn
}

/** Repositories the workspace could still attach: its space's, plus unassigned ones. */
export function candidates(workspaceId: string): Repo[] {
  const ws = getWorkspace(workspaceId)
  return getStore()
    .get()
    .repos.filter((r) => !ws.repos.some((x) => x.repoId === r.id) && (!ws.spaceId || !r.spaceId || r.spaceId === ws.spaceId))
}

export function promptFor(workspaceId: string): string {
  const ws = getWorkspace(workspaceId)
  const names = candidates(workspaceId).map((r) => r.name)
  if (ws.repos.length === 0) {
    return `This workspace has no repositories yet; its folder is ${ws.rootPath}. Before working on code, call add_repository with the repository the task needs${names.length ? ` (available: ${names.join(', ')})` : ''}. The user confirms, and a worktree on branch "${ws.slug}" is created inside the workspace folder.`
  }
  return names.length ? `Other repositories of this space can be attached with add_repository when the task needs them: ${names.join(', ')}.` : ''
}

function list(workspaceId: string): string {
  const ws = getWorkspace(workspaceId)
  const here = ws.repos.map((r) => `- ${r.repoName}: ${r.worktreePath} (branch ${r.branch}, from ${r.baseBranch})`)
  const more = candidates(workspaceId).map((r) => `- ${r.name} (default branch ${r.defaultBranch})`)
  return [`In this workspace:`, ...(here.length ? here : ['- none yet']), '', 'Available to add with add_repository:', ...(more.length ? more : ['- none; the user can register repositories in Settings → Repositories'])].join('\n')
}

async function add(workspaceId: string, name: string, baseBranch: string | undefined, onAdded?: () => void): Promise<string> {
  const options = candidates(workspaceId)
  const repo = options.find((r) => r.name.toLowerCase() === name.trim().toLowerCase())
  if (!repo) return `No repository named "${name}" can be added. ${options.length ? `Available: ${options.map((r) => r.name).join(', ')}.` : 'None are available; ask the user to register it in Settings → Repositories.'}`
  const ws = getWorkspace(workspaceId)
  const branch = ws.repos[0]?.branch ?? ws.slug
  const base = baseBranch?.trim() || repo.defaultBranch
  const q = await askQuestion(workspaceId, [
    {
      question: `Add ${repo.name} to this workspace? A worktree on branch "${branch}" from ${base} will be created at ${join(ws.rootPath, repo.name)}.`,
      header: 'Add repo',
      multiSelect: false,
      options: [
        { label: 'Add it', description: 'Create the worktree and run its setup script' },
        { label: 'Not now', description: 'Continue without it' }
      ]
    }
  ])
  const answer = Object.values(q.answers)[0] ?? ''
  if (q.cancelled || !/^add/i.test(answer)) return `The user declined adding ${repo.name}${q.response ? `: ${q.response}` : ''}. Continue without it or ask what they prefer.`
  const out = await addRepoToWorkspace(workspaceId, repo.id, base, emitScript)
  onAdded?.()
  const wr = out.repos.find((r) => r.repoId === repo.id)!
  return `Added ${repo.name}: worktree at ${wr.worktreePath} on branch ${wr.branch} (from ${wr.baseBranch}). You can read and change files there now.`
}

const listDesc = 'Repositories in this workspace and the ones that can still be added.'
const addDesc = 'Attach a repository of this space to the workspace as a worktree on the workspace branch. The user is asked to confirm first. Use the repository name from list_repositories.'

export function sdkServer(workspaceId: string, onAdded?: () => void): NonNullable<Options['mcpServers']>[string] {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  return createSdkMcpServer({
    name: 'workspace',
    tools: [
      sdkTool('list_repositories', listDesc, {}, async () => text(list(workspaceId))),
      sdkTool('add_repository', addDesc, { name: z.string(), base_branch: z.string().optional().describe('Branch to start from; default the repository default branch') }, async ({ name, base_branch }) => {
        try {
          return text(await add(workspaceId, name, base_branch, onAdded))
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Could not add ${name}: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
        }
      })
    ]
  })
}
export const SDK_ALLOWED = ['mcp__workspace__list_repositories', 'mcp__workspace__add_repository']

export function aiTools(workspaceId: string): ToolSet {
  return {
    list_repositories: aiTool({ description: listDesc, inputSchema: z.object({}), execute: async () => list(workspaceId) }),
    add_repository: aiTool({
      description: addDesc,
      inputSchema: z.object({ name: z.string(), base_branch: z.string().optional() }),
      execute: async ({ name, base_branch }) => {
        try {
          return await add(workspaceId, name, base_branch)
        } catch (err) {
          return `Could not add ${name}: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    })
  }
}
