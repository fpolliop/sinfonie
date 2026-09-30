/**
 * Team → Guardrails: the rules every agent in this space follows (and Maestro with them). Saved on the space and
 * shared with the team through the organisation sync; enforced in the main process by services/team-rules.ts.
 * Admins edit; everyone else reads the same rules in plain words. "How this is enforced" lists the known limits,
 * so the page never claims more than the code does: keep it in step with team-rules.ts.
 */
import React, { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useGuided, useWords } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'
import { Badge, Button, Field, SectionHeader, Toggle, inputCls } from '../ui'
import { isLookOnly, useAppKeys, useSpend } from './useTeamData'
import type { Space } from '@shared/types'

const money = (n: number): string => `$${n.toFixed(2)}`
/** "$25", "25", "25.50" → 25.5; empty → undefined; anything else → NaN. */
const parseMoney = (v: string): number | undefined => (v.trim() ? Number(v.trim().replace(/^\$\s*/, '')) : undefined)
const list = (v: string): string[] =>
  v
    .split(/[\s,]+/)
    .map((x) => x.replace(/^@/, '').trim())
    .filter(Boolean)

export function GuardrailsSection({ space, admin, onOpenApps }: { space: Space; admin: boolean; onOpenApps: () => void }): React.JSX.Element {
  const guided = useGuided()
  const t = useWords()
  const repos = useApp((s) => s.repos)
  const setError = useApp((s) => s.setError)
  const notify = useApp((s) => s.notify)
  const keys = useAppKeys(space.id)
  const spend = useSpend(space)
  const rules = space.rules ?? {}
  const saved = { paths: (rules.protectedPaths ?? []).join('\n'), review: Boolean(rules.requireReview), spend: rules.dailySpendUsd ? String(rules.dailySpendUsd) : '', reviewers: (space.guided?.reviewers ?? []).join(', ') }
  const [paths, setPaths] = useState(saved.paths)
  const [requireReview, setRequireReview] = useState(saved.review)
  const [spendText, setSpendText] = useState(saved.spend)
  const [reviewers, setReviewers] = useState(saved.reviewers)
  const [busy, setBusy] = useState(false)

  const reviewerList = list(reviewers)
  const dirty = paths.trim() !== saved.paths.trim() || requireReview !== saved.review || parseMoney(spendText) !== (rules.dailySpendUsd || undefined) || reviewerList.join(',') !== list(saved.reviewers).join(',')
  // A teammate's change arriving through the sync replaces the form, unless the admin is in the middle of editing.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    if (dirtyRef.current) return
    setPaths(saved.paths)
    setRequireReview(saved.review)
    setSpendText(saved.spend)
    setReviewers(saved.reviewers)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.paths, saved.review, saved.spend, saved.reviewers])

  const apps = repos.filter((r) => r.spaceId === space.id)
  const canChange = apps.filter((r) => !isLookOnly(space, r, keys))
  const lookOnly = apps.filter((r) => isLookOnly(space, r, keys))

  const save = async (): Promise<void> => {
    const n = parseMoney(spendText)
    if (n !== undefined && (!Number.isFinite(n) || n < 0)) return setError('The daily limit must be an amount in dollars, like 25.')
    setBusy(true)
    try {
      if (reviewerList.join(',') !== list(saved.reviewers).join(',')) await api.invoke('spaces:update', space.id, { guided: { ...(space.guided ?? {}), reviewers: reviewerList } })
      await api.invoke('team:setRules', space.id, { ...rules, protectedPaths: paths.split('\n'), requireReview, dailySpendUsd: n })
      notify({ kind: 'success', text: space.orgSpace ? 'Guardrails saved and shared with the team. Agents follow them from their next step.' : 'Guardrails saved. Agents follow them from their next step.' })
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }
  const lift = async (): Promise<void> => {
    try {
      await api.invoke('team:overrideSpend', space.id)
      notify({ kind: 'success', text: `Spending allowed for the rest of today in ${space.name}, on this Mac.` })
    } catch (err) {
      setError(friendlyError(err))
    }
  }
  const limit = rules.dailySpendUsd ?? 0
  const spent = spend?.spent ?? 0

  return (
    <div className="max-w-[720px]">
      <p className="mb-4 max-w-[72ch] text-[13px] text-muted">
        {guided
          ? `Rules for everyone building in ${space.name}. Maestro and its helpers check them before changing anything, and say so in plain words when a rule stops them.`
          : `Team-wide rules for ${space.name}. Agents are checked against them before file writes, edits and shell commands, and Maestro follows them too. Changes apply from the agent's next step. See the limits below.`}
      </p>

      <SectionHeader
        action={
          <Button size="sm" variant="ghost" onClick={onOpenApps}>
            {admin ? `Choose ${t.repos}` : `See ${t.repos}`}
          </Button>
        }
      >
        What builders can change
      </SectionHeader>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[13px]">
        {apps.length === 0 && (
          <span className="text-muted">
            No {t.repos} in this {t.space} yet.
          </span>
        )}
        {canChange.map((r) => (
          <Badge key={r.id} tone="ok">
            {r.displayName || r.name}
          </Badge>
        ))}
        {apps.length > 0 && canChange.length === 0 && <span className="text-muted">None: builders can only look.</span>}
      </div>
      {lookOnly.length > 0 && (
        <p className="text-[12px] text-muted">
          Look only: {lookOnly.map((r) => r.displayName || r.name).join(', ')}. Agents working for builders can read these but not change them.
        </p>
      )}

      <SectionHeader>{guided ? 'Never touch' : 'Protected paths'}</SectionHeader>
      <Field label={guided ? 'Folders and files no agent changes, one per line' : 'Globs, one per line, relative to each repository root'} hint={guided ? 'For example payments/ or .env files. Agents can still read them.' : 'payments/ covers the folder; *.sql matches at any depth; db/migrations/** anchors at the root. Writes, edits and shell commands that name them are refused; reading is allowed.'}>
        <textarea className={inputCls + ' h-24 font-mono'} value={paths} disabled={!admin} onChange={(e) => setPaths(e.target.value)} placeholder={'payments/\n.env*\ndb/migrations/'} />
      </Field>

      <SectionHeader>Before it ships</SectionHeader>
      <Toggle
        checked={requireReview}
        disabled={!admin}
        onChange={setRequireReview}
        label="Require a review"
        hint={guided ? 'Builders send each task for review before it can go live.' : 'Guided builders must use Send for review before a PR, and before marking done or merging; their agents may not open, merge or push PRs. Experts see a warning on the stage instead.'}
      />
      <div className="mt-3">
        <Field label={guided ? 'Who reviews (GitHub usernames)' : 'Reviewers requested on every Send for review (GitHub logins)'}>
          <input className={inputCls} value={reviewers} disabled={!admin} onChange={(e) => setReviewers(e.target.value)} placeholder="marta, jonas" />
        </Field>
        {requireReview && reviewerList.length === 0 && <p className="-mt-2 mb-2 text-[12px] text-warn">Builders can’t send anything for review until you add at least one reviewer.</p>}
      </div>

      <SectionHeader>Spend</SectionHeader>
      <Field label="Daily limit per person, in dollars" hint={`Leave empty for no limit. When someone reaches it, their new messages in this ${t.space} stop with a plain note until tomorrow (their local day), or until an admin on their Mac allows more.`}>
        <input className={inputCls + ' max-w-[160px]'} inputMode="decimal" value={spendText} disabled={!admin} onChange={(e) => setSpendText(e.target.value)} placeholder="25" />
      </Field>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <span>
          On this Mac you spent about {money(spent)} here today{limit ? ` of ${money(limit)}` : ''}.
        </span>
        {spend?.lifted && <Badge tone="warn">Limit lifted for today</Badge>}
        {admin && limit > 0 && spent >= limit && !spend?.lifted && (
          <Button size="sm" onClick={() => void lift()}>
            Allow more today
          </Button>
        )}
      </div>

      {admin ? (
        <div className="mt-5 flex items-center gap-2">
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save guardrails'}
          </Button>
          {rules.reviewedAt && <span className="text-[12px] text-muted">Last saved {new Date(rules.reviewedAt).toLocaleString()}</span>}
        </div>
      ) : (
        <p className="mt-5 text-[12px] text-muted">Only a team admin can change these.</p>
      )}

      <details className="mt-6 rounded-lg border border-border p-3 text-[12px] text-muted">
        <summary className="cursor-pointer text-[13px] font-medium text-text">How this is enforced</summary>
        {guided ? (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Maestro and its helpers check these rules before changing anything. If one changes a protected file anyway, it is put back.</li>
            <li>The check reads what a helper is about to do, not what it means, so an unusual workaround can slip through. Keep reviews on for anything important.</li>
            <li>The rules for builders apply to people who build in guided mode.</li>
            <li>Spending is an estimate from each person’s own Mac. Some AI services don’t report their cost, so their use isn’t counted.</li>
            <li>The spending limit is checked when a message is sent. Messages already waiting, scheduled runs and helpers that started before the limit was reached are not stopped.</li>
            <li>Rules are checked in each person’s app. Only admins can change them for the team, but someone who edits the settings on their own Mac can get around them.</li>
          </ul>
        ) : (
          <>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Claude Code (chat, crew and terminal): checked before every Write, Edit, NotebookEdit and Bash call, in every permission mode. A terminal session whose check can’t reach Sinfonie blocks the tool.</li>
              <li>API-key models: checked inside their write, edit and shell tools.</li>
              <li>Codex, Gemini CLI and Grok Build: kept in an asking mode while these rules apply, and every request is checked. A protected file they change without asking is put back after the edit: tracked files from the last commit, new files moved to the Trash.</li>
              <li>Maestro has no file tools. It gets the rules in its instructions, cannot change them, cannot mark unreviewed work done, and cannot send a message past the spend limit.</li>
            </ul>
            <div className="mt-3 font-medium text-text">Known limits</div>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>Shell commands are judged from their text. A script that builds its paths at run time is not caught; commands that only read may name protected paths.</li>
              <li>MCP tools (mcp__*) and browser actions are not checked against these rules.</li>
              <li>Builder rules (look-only apps, the review gate) follow each person’s own mode: the cloud has admin and member roles only, with no builder assignment.</li>
              <li>Enforcement runs in each person’s app. The server keeps rule changes admin-only when spaces sync, but a local settings edit gets around them.</li>
              <li>Spend is estimated at list price from each person’s own usage ledger, per local day. Codex, Gemini CLI and Grok Build report no cost, so they are not counted. Text typed straight into a terminal session is not stopped. The limit is checked when a message is sent, so messages already queued, scheduled runs and crew runs started before the limit was reached are not stopped.</li>
              <li>The review gate asks GitHub (gh) about pull requests opened outside Sinfonie and about approvals before a merge; if GitHub can’t be reached, a builder’s merge is refused.</li>
            </ul>
          </>
        )}
      </details>
    </div>
  )
}
