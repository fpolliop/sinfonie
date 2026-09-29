/**
 * Data sources a view can bind. Each lands at /data/<name> in the view's state (an array of rows)
 * with /meta/<name> = { count, loading, error, fetchedAt }. Renderer sources come from live stores;
 * main sources are fetched over IPC (views:data) and cached there.
 */
import { z } from 'zod'

export interface SourceDef {
  description: string
  where: 'renderer' | 'main'
  params: z.ZodObject
  /** Row fields, documented for Maestro: name -> meaning. */
  fields: Record<string, string>
  /** Needs the workspace the view is shown in (workspace-tab slot only). */
  needsWorkspace?: boolean
  refreshSeconds: number
}

export const SOURCES = {
  attention: {
    description: 'Things waiting for the user across every workspace: permission prompts, questions from agents, finished turns not looked at yet, workspaces in error.',
    where: 'renderer',
    params: z.object({ spaceId: z.string().optional().describe('Only this space') }),
    fields: {
      id: 'unique id',
      workspaceId: 'workspace id',
      workspace: 'workspace name',
      space: 'space name',
      kind: 'permission | question | done | error',
      status: 'waiting | success | error (for a Status dot)',
      text: 'what it is about, one line'
    },
    refreshSeconds: 0
  },
  workspaces: {
    description: 'Workspaces (not archived), most recently active first.',
    where: 'renderer',
    params: z.object({ spaceId: z.string().optional(), stage: z.enum(['todo', 'in-progress', 'on-hold', 'in-review', 'done']).optional(), limit: z.number().optional() }),
    fields: {
      id: 'workspace id',
      name: 'name',
      space: 'space name',
      spaceId: 'space id',
      stage: 'todo | in-progress | on-hold | in-review | done',
      status: 'running | waiting | none (agent state, for a Status dot)',
      branch: 'branch name',
      repos: 'repo names joined with ", "',
      repoCount: 'number of repos',
      ticket: 'linked Jira/Linear key or ""',
      lastActive: 'relative time, e.g. "5m ago"'
    },
    refreshSeconds: 0
  },
  usage: {
    description: 'Claude usage windows per account (5-hour and weekly) and today\'s spend.',
    where: 'renderer',
    params: z.object({}),
    fields: {
      id: 'account id + window',
      account: 'account name',
      label: '"<account> · <window>"',
      window: '"5-hour" | "weekly" | other window name',
      percent: '0..100',
      resetsIn: 'relative, e.g. "2h 10m"',
      status: 'success | pending | failure (under 80 / 80+ / 95+)'
    },
    refreshSeconds: 0
  },
  incidents: {
    description: 'On-call incidents from the watched Slack channels, newest first, with the triage summary and severity.',
    where: 'renderer',
    params: z.object({ spaceId: z.string().optional(), open: z.boolean().optional().describe('Only open ones (default true)'), limit: z.number().optional() }),
    fields: {
      id: 'incident id',
      title: 'what came in, one line',
      channel: 'Slack channel name',
      status: 'new | triaging | open | waiting | resolved | dismissed',
      dot: 'error | pending | running | waiting | success (status as a Status dot value)',
      severity: 'low | medium | high | critical or ""',
      summary: 'triage summary, or "" when not triaged yet',
      cause: 'likely cause from the triage, or ""',
      needsHuman: 'boolean: the triage says a person is needed',
      proposals: 'number of proposals waiting for approval',
      triaged: 'boolean',
      age: 'relative time since it arrived',
      url: 'Slack permalink or ""'
    },
    refreshSeconds: 0
  },
  myPrs: {
    description: 'Open pull requests authored by the user on GitHub (via the gh login), with CI and review state, linked to the Sinfonie workspace on the same branch.',
    where: 'main',
    params: z.object({ owners: z.array(z.string()).optional().describe('Limit to these GitHub users/orgs'), limit: z.number().optional() }),
    fields: {
      id: 'owner/name#number',
      repo: 'owner/name',
      repoName: 'name only',
      number: 'PR number',
      title: 'title',
      url: 'PR link',
      branch: 'head branch',
      draft: 'boolean',
      ci: 'success | failure | pending | none',
      review: 'approved | changes | review | none',
      reviewLabel: 'human label: "Approved", "Changes requested", "Review required", ""',
      mergeable: 'boolean: approved, CI green, no conflicts, not draft',
      conflicts: 'boolean',
      size: '"+120 −30"',
      updated: 'relative time',
      workspaceId: 'id of the Sinfonie workspace on this branch, or ""'
    },
    refreshSeconds: 90
  },
  reviewQueue: {
    description: 'Open pull requests where the user\'s review is requested.',
    where: 'main',
    params: z.object({ owners: z.array(z.string()).optional(), limit: z.number().optional() }),
    fields: {
      id: 'owner/name#number',
      repo: 'owner/name',
      number: 'PR number',
      title: 'title',
      url: 'PR link',
      author: 'login',
      ci: 'success | failure | pending | none',
      size: '"+120 −30"',
      updated: 'relative time'
    },
    refreshSeconds: 120
  },
  branchStatus: {
    description: 'One row per repo of the workspace the view is shown in: branch, commits ahead/behind, uncommitted files, PR and CI.',
    where: 'main',
    params: z.object({}),
    needsWorkspace: true,
    fields: {
      id: 'repo id',
      repo: 'repo name',
      branch: 'branch',
      base: 'base branch',
      ahead: 'commits ahead of upstream (or of base when never pushed)',
      behind: 'commits behind upstream',
      dirty: 'uncommitted files',
      pushed: 'boolean: has an upstream',
      sync: 'short text, e.g. "↑2 ↓0 · 3 changed" or "clean"',
      pr: '"#412" or ""',
      prUrl: 'link or ""',
      prState: 'OPEN | MERGED | CLOSED | ""',
      ci: 'success | failure | pending | none'
    },
    refreshSeconds: 30
  },
  tickets: {
    description: "Tickets from the space's Jira (its default JQL, or `jql`) or Linear (`query`), each with the state of its Sinfonie workspace.",
    where: 'main',
    params: z.object({ provider: z.enum(['jira', 'linear']).optional().describe('Default: whichever the space has connected'), jql: z.string().optional(), query: z.string().optional(), spaceId: z.string().optional().describe('Default: the space the view is shown in'), limit: z.number().optional() }),
    fields: {
      id: 'ticket key',
      key: 'key, e.g. LUM-231',
      title: 'summary',
      url: 'link',
      provider: 'jira | linear',
      providerId: 'Linear issue id ("" for Jira)',
      status: 'ticket status name',
      lane: 'todo | doing | review | done (derived from ticket status and workspace)',
      workspaceId: 'linked workspace id or ""',
      workspaceState: 'none | running | waiting | idle | review',
      agent: 'running | waiting | pending | none (workspaceState as a Status dot value)',
      assignee: 'name or ""',
      priority: 'priority or ""'
    },
    refreshSeconds: 120
  }
} as const satisfies Record<string, SourceDef>

export type SourceId = keyof typeof SOURCES
export const isSourceId = (s: string): s is SourceId => s in SOURCES
