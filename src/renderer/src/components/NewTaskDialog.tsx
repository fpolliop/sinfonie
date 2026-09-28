import React, { useMemo, useState } from 'react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { Button, Dialog, inputCls } from './ui'
import { friendlyError } from '@/lib/errors'
import { humanTitle, repoLabel } from '@/lib/labels'
import { PERSONAL_SPACE_NAME } from '@/lib/soloApp'
import { SoloApp } from './onboarding/SetupWizard'
import { IssuePicker } from './NewWorkspaceDialog'
import { jiraConnectionFor, linearConnectionFor, type JiraIssue, type LinearIssue, type WorkspaceJira, type WorkspaceLinear } from '@shared/types'

/**
 * Guided mode's New task: one question, "what do you want to build or change?". The assistant picks the apps
 * (or the person does), the task gets a readable name (the planner's, else the request in sentence case; the
 * branch is derived from it behind the scenes), and the description becomes the first message, sent as soon
 * as the task is ready. With no app yet, the dialog offers to add one right here instead of a dead end.
 */
export function NewTaskDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { repos: allRepos, spaces, select, setError, settings, newWorkspaceSpaceId, newWorkspaceSeed, setNewWorkspaceSeed, openSettings } = useApp()
  const orgs = settings.cloud?.account?.orgs ?? []
  const teamSpaces = useMemo(() => spaces.filter((sp) => sp.orgId && orgs.some((o) => o.id === sp.orgId)), [spaces, orgs])
  // The team's apps, plus the person's own ("My apps") when they also added one on their own.
  const candidates = useMemo(() => (teamSpaces.length ? [...teamSpaces, ...spaces.filter((s) => !s.orgId && s.name === PERSONAL_SPACE_NAME)] : spaces), [teamSpaces, spaces])
  const [addFrom, setAddFrom] = useState<'mac' | 'github'>('mac')
  const [spaceId, setSpaceId] = useState(() => (candidates.some((s) => s.id === newWorkspaceSpaceId) ? newWorkspaceSpaceId : candidates[0]?.id ?? ''))
  const space = spaces.find((s) => s.id === spaceId)
  const repos = useMemo(() => allRepos.filter((r) => r.spaceId === spaceId), [allRepos, spaceId])
  const [off, setOff] = useState<Set<string>>(new Set())
  const [text, setText] = useState(newWorkspaceSeed?.draft ?? '')
  const [jira, setJira] = useState<WorkspaceJira | null>(null)
  const [linear, setLinear] = useState<WorkspaceLinear | null>(null)
  const [busy, setBusy] = useState(false)
  // Let the assistant pick the apps from the description by default when there is more than one; the person
  // can switch to choosing them by hand.
  const [autoApps, setAutoApps] = useState(true)
  const jiraConn = jiraConnectionFor(space)
  const jiraReady = jiraConn ? true : settings.jira.connected || Boolean(settings.jira.siteUrl && settings.jira.email && settings.jira.hasToken)
  const linearConn = linearConnectionFor(space)
  const linearReady = linearConn ? true : Boolean(settings.linear?.connected)
  const chosen = repos.filter((r) => !off.has(r.id))
  const auto = autoApps && repos.length > 1
  const canStart = text.trim().length > 0 && (auto ? repos.length > 0 : chosen.length > 0) && !busy

  const submit = async (): Promise<void> => {
    if (!canStart) return
    setBusy(true)
    try {
      // The assistant chooses the apps and a friendly name from the description, unless a ticket or a manual
      // pick already settled it.
      let picked = chosen
      let planned = ''
      if (auto && !jira && !linear) {
        const p = await api.invoke('guided:plan', spaceId, text.trim())
        const byPlan = repos.filter((r) => p.repoIds.includes(r.id))
        picked = byPlan.length ? byPlan : repos
        planned = p.name
      }
      // A readable name; workspaces:create derives the branch and folder from it.
      const name = jira ? humanTitle(`${jira.key}: ${jira.summary}`) : linear ? humanTitle(`${linear.identifier}: ${linear.title}`) : planned || humanTitle(text)
      const ws = await api.invoke('workspaces:create', {
        name,
        repos: picked.map((r) => ({ repoId: r.id, baseBranch: r.defaultBranch })),
        primaryRepoId: picked[0].id,
        ...(jira ? { jira } : {}),
        ...(linear ? { linear } : {}),
        claudeAccountId: space?.claudeAccountId ?? settings.defaultClaudeAccountId,
        spaceId
      })
      select(ws.id)
      setNewWorkspaceSeed(null)
      onClose()
      const first = [text.trim(), jira ? `\nThis is for ticket ${jira.key}: ${jira.summary}\n${jira.url}` : '', linear ? `\nThis is for ${linear.identifier}: ${linear.title}\n${linear.url}` : ''].join('')
      sendWhenReady(ws.id, first)
    } catch (err) {
      setError(friendlyError(err, 'The task could not start. Try again, or ask a teammate.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="New task" onClose={onClose} width={560}>
      <label className="mb-1 block text-[12px] font-medium text-muted">What do you want to build or change?</label>
      <textarea
        autoFocus
        className={clsx(inputCls, 'mb-3 min-h-[120px] resize-y')}
        placeholder="Say it the way you would to a colleague. What it is, where it is, what should be different. Paste a screenshot into the chat afterwards if it helps."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
        }}
      />
      {jiraReady && (
        <IssuePicker<JiraIssue>
          key={`jira-${jiraConn}`}
          label="Jira ticket"
          enabled
          selected={jira ? { key: jira.key, title: jira.summary, url: jira.url } : null}
          search={(q) => api.invoke('jira:search', jiraConn, q)}
          view={(i) => ({ key: i.key, title: i.summary, meta: `${i.type} · ${i.status}`, url: i.url })}
          onSelect={(issue) => {
            if (!issue) return setJira(null)
            setLinear(null)
            setJira({ key: issue.key, summary: issue.summary, url: issue.url })
            if (!text.trim()) setText(issue.summary)
          }}
          onConfigure={() => (onClose(), openSettings({ scope: 'app', page: 'plan' }))}
        />
      )}
      {linearReady && (
        <IssuePicker<LinearIssue>
          key={`linear-${linearConn}`}
          label="Linear issue"
          enabled
          selected={linear ? { key: linear.identifier, title: linear.title, url: linear.url } : null}
          search={(q) => api.invoke('linear:search', linearConn, q)}
          view={(i) => ({ key: i.identifier, title: i.title, meta: [i.state, i.priority].filter(Boolean).join(' · '), url: i.url })}
          onSelect={(issue) => {
            if (!issue) return setLinear(null)
            setJira(null)
            setLinear({ id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url })
            if (!text.trim()) setText(issue.title)
          }}
          onConfigure={() => (onClose(), openSettings({ scope: 'app', page: 'plan' }))}
        />
      )}
      {candidates.length > 1 && (
        <div className="mb-3 flex items-center gap-2 text-[12px]">
          <span className="text-muted">Team</span>
          <select className={clsx(inputCls, 'w-auto')} value={spaceId} onChange={(e) => (setSpaceId(e.target.value), setOff(new Set()))}>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-muted">
        Apps this touches
        {repos.length > 1 && (
          <button className="ml-auto text-[11px] font-normal text-accent hover:underline" onClick={() => setAutoApps((v) => !v)}>
            {auto ? 'Choose them myself' : 'Let the assistant choose'}
          </button>
        )}
      </div>
      {repos.length === 0 ? (
        <div className="mb-4 rounded-md border border-border p-3 text-[12px]">
          <p className="mb-2 text-muted">{teamSpaces.some((sp) => sp.id === spaceId) ? 'Your team’s apps are still being set up. Try again in a minute, or add an app of your own:' : 'Add the app this task is for. You only do this once.'}</p>
          <div role="radiogroup" aria-label="Where your app is" className="mb-2 flex gap-1">
            {(
              [
                ['mac', 'It’s on this Mac'],
                ['github', 'It’s on GitHub']
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={addFrom === id} className={clsx('rounded-md px-2 py-1 text-[12px]', addFrom === id ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} onClick={() => setAddFrom(id)}>
                {label}
              </button>
            ))}
            {orgs.length === 0 && (
              <button type="button" className="ml-auto text-[12px] text-accent hover:underline" onClick={() => (onClose(), openSettings({ scope: 'app', page: 'plan' }))}>
                My team already uses Sinfonie
              </button>
            )}
          </div>
          <SoloApp key={addFrom} source={addFrom} onSpace={(id) => (setSpaceId(id), setOff(new Set()))} />
        </div>
      ) : auto ? (
        <div className="mb-4 rounded-md border border-dashed border-border p-3 text-[12px] text-muted">The assistant picks the right apps from what you describe, out of {repos.map((r) => repoLabel(r)).join(', ')}. It only changes what the task needs.</div>
      ) : (
        <>
          <div className="mb-1 flex flex-wrap gap-1.5">
            {repos.map((r) => {
              const on = !off.has(r.id)
              return (
                <button
                  key={r.id}
                  onClick={() =>
                    setOff((s) => {
                      const n = new Set(s)
                      if (n.has(r.id)) n.delete(r.id)
                      else n.add(r.id)
                      return n
                    })
                  }
                  className={clsx('rounded-full border px-2.5 py-1 text-[12px]', on ? 'border-accent/50 bg-accent/10 text-text' : 'border-border text-muted')}
                  title={on ? 'Included. Click to leave it out.' : 'Left out. Click to include it.'}
                >
                  {repoLabel(r)}
                </button>
              )
            })}
          </div>
          <p className="mb-4 text-[11px] text-muted">The assistant only changes what the task needs.</p>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canStart} onClick={() => void submit()} aria-keyshortcuts="Meta+Enter" title="Start (⌘↵)">
          {busy ? 'Starting…' : 'Start'}
          {!busy && <kbd className="ml-1 rounded bg-black/30 px-1 text-[11px]" aria-hidden>⌘↵</kbd>}
        </Button>
      </div>
    </Dialog>
  )
}

/** Sends the first message once the task's folders exist; gives up quietly after ten minutes. */
function sendWhenReady(workspaceId: string, text: string): void {
  const send = useChat.getState().send
  const setDraft = useChat.getState().setDraft
  setDraft(workspaceId, text)
  const attempt = (): boolean => {
    const ws = useApp.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return true
    if (ws.status === 'ready') {
      void send(workspaceId, text)
      return true
    }
    return ws.status === 'error' || ws.status === 'archived'
  }
  if (attempt()) return
  const stop = useApp.subscribe(() => {
    if (attempt()) {
      stop()
      clearTimeout(timer)
    }
  })
  const timer = setTimeout(stop, 10 * 60_000)
}
