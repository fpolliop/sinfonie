/**
 * What to offer when a subscription window is nearly full or just ran out: the fullest window of
 * the workspace's account, and the ways forward (proceed, another signed-in account, another
 * engine, the native loop with an API key). Pure helpers; the flow itself lives in ipc.ts.
 */
import { nanoid } from 'nanoid'
import { getStore } from '../store'
import { defaultAccountId } from './accounts'
import * as usage from './usage'
import { probeCache } from './acp/engine'
import type { AgentEvent, LimitAlternative, Workspace } from '@shared/types'

export function accountIdOf(ws: Workspace): string {
  return ws.claudeAccountId ?? defaultAccountId('anthropic') ?? 'default'
}

export function alternativesFor(ws: Workspace, accountId: string, mode: 'preflight' | 'hit'): LimitAlternative[] {
  const { settings } = getStore().get()
  const out: LimitAlternative[] = []
  if (mode === 'preflight') out.push({ kind: 'proceed', label: 'Proceed anyway', hint: 'Start the task on this account; you may run out midway.' })
  for (const a of settings.claudeAccounts) {
    if ((a.vendor ?? 'anthropic') !== 'anthropic' || a.id === accountId || a.loggedIn === false) continue
    const risk = usage.riskyLimit(a.id)
    out.push({ kind: 'account', id: a.id, label: `Continue on ${a.name}`, hint: risk ? `${Math.round(risk.utilization * 100)}% of its ${risk.type.replace(/_/g, ' ')} window used` : 'The conversation carries over.' })
  }
  for (const [engine, label] of [
    ['codex', 'Codex'],
    ['gemini', 'Gemini CLI'],
    ['grok', 'Grok Build']
  ] as const) {
    if (probeCache[engine]?.signedIn) out.push({ kind: 'engine', id: engine, label: `Continue on ${label}`, hint: 'A recap of this conversation is handed over; the session restarts there.' })
  }
  if ((settings.providers ?? []).length) out.push({ kind: 'native', label: 'Continue with an API key', hint: 'Sinfonie’s native loop on one of your model providers, billed per token.' })
  out.push({ kind: 'cancel', label: mode === 'preflight' ? 'Not now' : 'Wait for the reset' })
  return out
}

const fmtTime = (iso?: string): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'later')
const windowName = (t?: string): string => (t === 'five_hour' ? '5-hour' : t?.startsWith('seven_day') ? 'weekly' : (t ?? 'usage'))

/** The card to show before starting a turn, or null when the account has room. */
export function preflightEvent(ws: Workspace): Extract<AgentEvent, { type: 'limit' }> | null {
  const accountId = accountIdOf(ws)
  const risk = usage.riskyLimit(accountId)
  if (!risk) return null
  const name = getStore().get().settings.claudeAccounts.find((a) => a.id === accountId)?.name ?? accountId
  const left = Math.max(0, Math.round((1 - risk.utilization) * 100))
  const eta = risk.projectedExhaustAt ? ` At the recent pace it runs out around ${fmtTime(risk.projectedExhaustAt)}.` : ''
  return {
    type: 'limit',
    workspaceId: ws.id,
    itemId: nanoid(8),
    mode: 'preflight',
    accountId,
    accountName: name,
    limitType: risk.type,
    utilization: risk.utilization,
    resetsAt: risk.resetsAt,
    text: `${name} has about ${left}% of its ${windowName(risk.type)} limit left (resets ${fmtTime(risk.resetsAt)}).${eta} A task started now may run out midway.`,
    alternatives: alternativesFor(ws, accountId, 'preflight'),
    createdAt: new Date().toISOString()
  }
}

export function hitEvent(ws: Workspace, info: { rateLimitType?: string; resetsAt?: number }): Extract<AgentEvent, { type: 'limit' }> {
  const accountId = accountIdOf(ws)
  const name = getStore().get().settings.claudeAccounts.find((a) => a.id === accountId)?.name ?? accountId
  const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : undefined
  return {
    type: 'limit',
    workspaceId: ws.id,
    itemId: nanoid(8),
    mode: 'hit',
    accountId,
    accountName: name,
    limitType: info.rateLimitType as never,
    utilization: 1,
    resetsAt,
    text: `${name} hit its ${windowName(info.rateLimitType)} limit; it resets ${fmtTime(resetsAt)}. The current turn stopped.`,
    alternatives: alternativesFor(ws, accountId, 'hit'),
    createdAt: new Date().toISOString()
  }
}

/** A compact recap of the conversation for handing a task to another engine. */
export function recap(items: { role: string; blocks: { type: string; text?: string }[] }[], maxChars = 6000): string {
  const lines: string[] = []
  for (const it of items.slice(-16)) {
    if (it.role !== 'user' && it.role !== 'assistant') continue
    const text = it.blocks
      .filter((b) => b.type === 'text' && b.text?.trim())
      .map((b) => b.text!.trim())
      .join('\n')
    if (text) lines.push(`${it.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 1200)}`)
  }
  let out = lines.join('\n\n')
  if (out.length > maxChars) out = '…' + out.slice(-maxChars)
  return out
}
