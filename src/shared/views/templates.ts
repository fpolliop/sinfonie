/**
 * Starter views. The gallery installs them as-is; Maestro starts from them when asked for something
 * close. Each must pass validateView (checked in the views test script).
 */
import type { ViewInput, ViewScope } from './types'

export interface ViewTemplate {
  id: string
  title: string
  description: string
  /** Where it is installed by default. */
  scope: ViewScope['kind']
  /** Offered to guided-mode users too. */
  guided: boolean
  view: ViewInput
}

const item = (field: string): { $item: string } => ({ $item: field })
const ctx = (field: string): { $state: string } => ({ $state: `/context/${field}` })

const morning: ViewInput = {
  title: 'Morning cockpit',
  slot: 'home',
  icon: 'sun',
  template: 'morning-cockpit',
  sources: { attention: { source: 'attention' }, prs: { source: 'myPrs' }, usage: { source: 'usage' } },
  spec: {
    root: 'page',
    elements: {
      page: { type: 'Stack', props: { gap: 'md' }, children: ['grid'] },
      grid: { type: 'Grid', props: { columns: 3, gap: 'md' }, children: ['needs', 'usageCard', 'prsCard'] },
      needs: { type: 'Card', props: { title: 'Needs you', icon: 'bell', span: 2 }, children: ['needsList'] },
      needsList: {
        type: 'List',
        props: { emptyText: 'Nothing is waiting for you.', count: { $state: '/meta/attention/count' } },
        repeat: { statePath: '/data/attention', key: 'id' },
        children: ['needsItem']
      },
      needsItem: {
        type: 'ListItem',
        props: { title: item('workspace'), subtitle: item('text'), meta: item('space'), status: item('status') },
        on: { press: { action: 'openWorkspace', params: { workspaceId: item('workspaceId') } } },
        children: ['needsOpen']
      },
      needsOpen: { type: 'Button', props: { label: 'Open', size: 'sm', variant: 'ghost', icon: 'arrow-right' }, on: { press: { action: 'openWorkspace', params: { workspaceId: item('workspaceId') } } } },
      usageCard: { type: 'Card', props: { title: 'Usage', icon: 'gauge' }, children: ['usageList'] },
      usageList: {
        type: 'List',
        props: { emptyText: 'No usage readings yet.', count: { $state: '/meta/usage/count' } },
        repeat: { statePath: '/data/usage', key: 'id' },
        children: ['usageMeter']
      },
      usageMeter: { type: 'Meter', props: { label: item('label'), value: item('percent'), hint: item('resetsIn') } },
      prsCard: { type: 'Card', props: { title: 'My pull requests', icon: 'git-pull-request', span: 3 }, children: ['prsList'] },
      prsList: {
        type: 'List',
        props: { emptyText: 'No open pull requests.', count: { $state: '/meta/prs/count' }, divided: true },
        repeat: { statePath: '/data/prs', key: 'id' },
        children: ['prItem']
      },
      prItem: {
        type: 'ListItem',
        props: { title: item('title'), subtitle: { $template: '${repoName} #${number}' }, meta: item('updated'), status: item('ci') },
        on: { press: { action: 'openUrl', params: { url: item('url') } } },
        children: ['prDraft', 'prReview', 'prFix', 'prWs', 'prMerge']
      },
      prDraft: { type: 'Badge', props: { label: 'Draft', tone: 'muted' }, visible: { $item: 'draft', eq: true } },
      prReview: { type: 'Badge', props: { label: item('reviewLabel'), tone: 'muted' }, visible: { $item: 'reviewLabel', neq: '' } },
      prFix: {
        type: 'Button',
        props: { label: 'Fix with agent', size: 'sm', icon: 'wrench' },
        visible: [{ $item: 'ci', eq: 'failure' }, { $item: 'workspaceId', neq: '' }],
        on: { press: { action: 'fixWithAgent', params: { workspaceId: item('workspaceId'), number: item('number'), repo: item('repo') } } }
      },
      prWs: {
        type: 'Button',
        props: { label: 'Workspace', size: 'sm', variant: 'ghost', icon: 'folder' },
        visible: { $item: 'workspaceId', neq: '' },
        on: { press: { action: 'openWorkspace', params: { workspaceId: item('workspaceId') } } }
      },
      prMerge: {
        type: 'Button',
        props: { label: 'Merge', size: 'sm', variant: 'primary', icon: 'git-merge' },
        visible: { $item: 'mergeable', eq: true },
        on: { press: { action: 'mergePr', params: { repo: item('repo'), number: item('number') } } }
      }
    }
  }
}

const branch: ViewInput = {
  title: 'Branch',
  slot: 'workspace-tab',
  icon: 'git-branch',
  template: 'branch-panel',
  sources: { repos: { source: 'branchStatus' } },
  spec: {
    root: 'page',
    elements: {
      page: { type: 'Stack', props: { gap: 'md' }, children: ['head', 'card'] },
      head: { type: 'Stack', props: { direction: 'row', justify: 'between', align: 'center', wrap: true, gap: 'sm' }, children: ['title', 'actions'] },
      title: { type: 'Heading', props: { text: { $template: 'Branch ${/context/branch}' }, level: 2 } },
      actions: { type: 'Stack', props: { direction: 'row', gap: 'xs', wrap: true }, children: ['refresh', 'rebase', 'push', 'prs'] },
      refresh: { type: 'Button', props: { label: 'Refresh', size: 'sm', variant: 'ghost', icon: 'refresh-cw' }, on: { press: { action: 'refresh', params: {} } } },
      rebase: { type: 'Button', props: { label: 'Rebase all on base', size: 'sm', icon: 'git-branch' }, on: { press: { action: 'rebaseAll', params: { workspaceId: ctx('workspaceId') } } } },
      push: { type: 'Button', props: { label: 'Push all', size: 'sm', icon: 'upload' }, on: { press: { action: 'pushAll', params: { workspaceId: ctx('workspaceId') } } } },
      prs: { type: 'Button', props: { label: 'Open PRs in all repos', size: 'sm', variant: 'primary', icon: 'git-pull-request' }, on: { press: { action: 'openPrsAll', params: { workspaceId: ctx('workspaceId') } } } },
      card: { type: 'Card', props: {}, children: ['list'] },
      list: {
        type: 'List',
        props: { emptyText: 'This workspace has no repositories yet.', count: { $state: '/meta/repos/count' }, divided: true },
        repeat: { statePath: '/data/repos', key: 'id' },
        children: ['row']
      },
      row: { type: 'ListItem', props: { title: item('repo'), subtitle: item('branch'), meta: item('sync'), status: item('ci') }, children: ['base', 'pr'] },
      base: { type: 'Badge', props: { label: { $template: 'base ${base}' }, tone: 'muted' } },
      pr: {
        type: 'Button',
        props: { label: item('pr'), size: 'sm', variant: 'ghost', icon: 'external-link' },
        visible: { $item: 'pr', neq: '' },
        on: { press: { action: 'openUrl', params: { url: item('prUrl') } } }
      }
    }
  }
}

const lane = (id: string, title: string, value: string, extra: string[] = []): Record<string, ViewInput['spec']['elements'][string]> => ({
  [id]: { type: 'Column', props: { title }, repeat: { statePath: '/data/tickets', key: 'id' }, visible: { $item: 'lane', eq: value }, children: [`${id}Tile`] },
  [`${id}Tile`]: {
    type: 'Tile',
    props: { title: item('title'), subtitle: item('key'), meta: item('assignee'), status: item('agent') },
    on: { press: { action: 'openUrl', params: { url: item('url') } } },
    children: [...extra.map((e) => `${id}${e}`), `${id}Open`]
  },
  ...(extra.includes('Start')
    ? {
        [`${id}Start`]: {
          type: 'Button',
          props: { label: 'Start', size: 'sm', variant: 'primary', icon: 'play' },
          visible: { $item: 'workspaceId', eq: '' },
          on: { press: { action: 'createWorkspaceFromTicket', params: { key: item('key'), title: item('title'), url: item('url'), provider: item('provider'), id: item('providerId') } } }
        }
      }
    : {}),
  [`${id}Open`]: {
    type: 'Button',
    props: { label: 'Workspace', size: 'sm', variant: 'ghost', icon: 'folder' },
    visible: { $item: 'workspaceId', neq: '' },
    on: { press: { action: 'openWorkspace', params: { workspaceId: item('workspaceId') } } }
  }
})

const board: ViewInput = {
  title: 'Ticket board',
  slot: 'home',
  icon: 'kanban',
  template: 'ticket-board',
  sources: { tickets: { source: 'tickets' } },
  spec: {
    root: 'page',
    elements: {
      page: { type: 'Stack', props: { gap: 'md' }, children: ['head', 'empty', 'lanes'] },
      head: { type: 'Stack', props: { direction: 'row', justify: 'between', align: 'center' }, children: ['title', 'refresh'] },
      title: { type: 'Heading', props: { text: { $template: '${/context/spaceName} tickets' }, level: 2 } },
      refresh: { type: 'Button', props: { label: 'Refresh', size: 'sm', variant: 'ghost', icon: 'refresh-cw' }, on: { press: { action: 'refresh', params: {} } } },
      empty: {
        type: 'Empty',
        props: { text: 'No tickets', hint: 'Connect Jira or Linear for this space, or check its default filter.', icon: 'ticket' },
        visible: [{ $state: '/meta/tickets/count', eq: 0 }, { $state: '/meta/tickets/loading', eq: false }]
      },
      lanes: { type: 'Stack', props: { direction: 'row', gap: 'md', align: 'stretch' }, children: ['todo', 'doing', 'review', 'done'] },
      ...lane('todo', 'To do', 'todo', ['Start']),
      ...lane('doing', 'Agent working', 'doing'),
      ...lane('review', 'In review', 'review'),
      ...lane('done', 'Done', 'done')
    }
  }
}

export const TEMPLATES: ViewTemplate[] = [
  { id: 'morning-cockpit', title: 'Morning cockpit', description: 'What needs you, your open PRs with CI and review, and usage, across every space.', scope: 'user', guided: false, view: morning },
  { id: 'branch-panel', title: 'Branch panel', description: 'A workspace tab: the branch in every repo, ahead/behind, changes, PR and CI, with rebase, push and open PRs for all.', scope: 'user', guided: false, view: branch },
  { id: 'ticket-board', title: 'Ticket board', description: "The space's Jira or Linear tickets as a board, with the state of each ticket's workspace and a Start button.", scope: 'space', guided: true, view: board }
]
