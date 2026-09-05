import { claudeExecutableOption } from '../claude-cli'
import * as usage from '../usage'
import { defaultAccountId } from '../accounts'
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { CrewPriority, AgentSpec, CrewSuggestion, Engine, ModelInventoryItem } from '@shared/types'
import { ACP_ENGINES, CLAUDE_MODELS, PROVIDER_KINDS, classifyModel } from '@shared/types'
import { getStore } from '../../store'
import { accountEnv } from '../accounts'
import { probeCache, probeCacheAt, probe } from '../acp/engine'
import { estimateCost } from '../providers'

const AGENT_SOURCE: Record<string, string> = { codex: 'Codex (ChatGPT login)', gemini: 'Gemini CLI (Google API key)', grok: 'Grok Build (grok.com login)' }

function priceOf(modelId: string): string | undefined {
  const inM = estimateCost(modelId, 1_000_000, 0)
  const outM = estimateCost(modelId, 0, 1_000_000)
  return inM || outM ? `$${+inM.toFixed(2)} / $${+outM.toFixed(2)} per M tokens` : undefined
}

/** Every model the crew can use, from every source, with availability. Uses probe results already collected; pass `refresh` to probe signed-in vendor agents now. */
export async function inventory(refresh = false): Promise<ModelInventoryItem[]> {
  const { settings } = getStore().get()
  const out: ModelInventoryItem[] = []
  const claudeOk = settings.claudeAccounts.some((a) => (a.vendor ?? 'anthropic') === 'anthropic' && a.loggedIn !== false)
  for (const m of CLAUDE_MODELS) out.push({ ref: m.id, kind: 'claude', source: 'Claude (your Claude login)', label: m.alias ? `${m.id} · ${m.label}` : m.label, price: m.price ? `$${m.price[0]} / $${m.price[1]} per M tokens` : undefined, available: claudeOk, note: m.alias ? 'alias for the newest of its tier' : undefined })
  for (const p of settings.providers ?? []) {
    const kind = PROVIDER_KINDS.find((k) => k.id === p.kind)
    const local = p.kind === 'ollama' || p.kind === 'lmstudio'
    for (const id of p.models ?? []) out.push({ ref: `${p.id}/${id}`, kind: 'provider', source: `${p.name} (${kind?.label ?? p.kind}, API key)`, label: id, price: local ? 'free, runs locally' : priceOf(id), available: p.hasKey || local })
  }
  // Vendor agents: use a probe from the last 10 minutes; otherwise probe them all at once, 20 s each at most,
  // so an npx download of one CLI cannot hold the whole dialog hostage.
  const wanted = ACP_ENGINES.filter((e) => {
    const acc = settings.claudeAccounts.find((a) => a.vendor === (e.id === 'codex' ? 'openai' : e.id === 'gemini' ? 'google' : 'xai') && a.loggedIn)
    const fresh = probeCache[e.id] && Date.now() - (probeCacheAt[e.id] ?? 0) < 10 * 60_000
    return refresh && !fresh && (acc || e.id === 'gemini')
  })
  await Promise.all(wanted.map((e) => Promise.race([probe(e.id).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000))])))
  for (const e of ACP_ENGINES) {
    const pr = probeCache[e.id]
    for (const m of pr?.models ?? []) out.push({ ref: `${e.id}/${m}`, kind: 'agent', source: AGENT_SOURCE[e.id], label: m, price: 'subscription', available: pr?.signedIn ?? false })
  }
  return out
}

const SCHEMA = {
  type: 'object',
  properties: {
    orchestrator: { type: 'object', properties: { model: { type: 'string' }, why: { type: 'string' } }, required: ['model', 'why'] },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] }, why: { type: 'string' } },
        required: ['id', 'model', 'why']
      }
    },
    notes: { type: 'string' }
  },
  required: ['orchestrator', 'agents']
}

/** Ask Claude which of the user's models should drive the orchestrator and each crew member. */
export async function suggest(spaceId?: string, priority: CrewPriority = 'balanced'): Promise<CrewSuggestion> {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  const engine: Engine = space?.engine ?? settings.engine ?? 'claude-code'
  const crew: AgentSpec[] = space?.agents ?? settings.agents
  const orchestratorNow = space?.model || (engine === 'native' ? settings.nativeModel : engine === 'claude-code' ? settings.model : (settings[`${engine}Model` as 'codexModel'] as string | undefined)) || ''
  const inv = (await inventory(true)).filter((i) => i.available)
  if (inv.length === 0) throw new Error('No usable models found. Sign in to an account or add a model provider first.')
  const orchestratorRule =
    engine === 'claude-code'
      ? 'The orchestrator runs on Claude Code, so its model must be one of the Claude entries (an alias like "opus" or an exact id).'
      : engine === 'native'
        ? 'The orchestrator runs on the Sinfonie native loop, so its model must be a provider entry ("<provider>/<model>"), never a Claude alias or a vendor agent.'
        : `The orchestrator is the ${engine} vendor agent, so its model must be one of the "${engine}/..." entries.`
  const prompt = [
    'You are configuring a coding crew inside Sinfonie: an orchestrator model that talks to the user and plans, plus subagents it delegates to. Assign a model to the orchestrator and to every crew member, from the inventory below, and explain each choice in one short sentence.',
    '',
    priority === 'cost'
      ? 'The user is on a limited subscription and wants to stretch it. Principles: the orchestrator should be a mid-tier model (Claude Sonnet, not Opus or Fable) unless the crew cannot carry the load; exploration and test-running must use the cheapest capable model (Haiku or a local model); implementation uses Sonnet; review uses Sonnet, or a different vendor\u2019s mid-tier model. Effort low for high-volume roles, medium at most for the orchestrator. Never recommend Opus or Fable for cost mode.'
      : priority === 'quality'
        ? 'The user wants the best result and accepts the cost. Principles: the orchestrator gets the strongest judgment available (Fable or Opus); review gets the most careful model, ideally a different vendor\u2019s strongest; implementation a strong coding model; exploration and test-running can still use a cheap model, since they only gather facts. Effort high for orchestrator and reviewer.'
        : 'Principles: the orchestrator needs the strongest judgment available (planning, integration, talking to the user). Exploration and test-running are high-volume and should use the cheapest capable model. Implementation needs a strong coding model. Review needs the most careful model. Prefer models included in a subscription the user already pays for (Claude login, vendor agents marked "subscription") over per-token API keys when quality is similar; use local models only for cheap read-only work unless nothing else is available. Mixing vendors is fine and often good: a different vendor for review catches different mistakes.',
    orchestratorRule,
    'Crew members may use any entry regardless of engine. Use the exact "ref" strings. Effort is one of low, medium, high, xhigh, max; omit it for models that do not support it (only Claude models do).',
    '',
    `Engine: ${engine}. Current orchestrator model: ${orchestratorNow || '(none)'}.`,
    '',
    'Crew members:',
    ...crew.map((a) => `- id=${a.id} name=${a.name} enabled=${a.enabled} current=${a.model}${a.effort ? ` effort=${a.effort}` : ''} tools=${a.tools?.length ? a.tools.join(',') : 'all'}: ${a.description}`),
    '',
    'Inventory (ref · source · price):',
    ...inv.map((i) => `- ${i.ref} · ${i.source} · ${i.price ?? 'price unknown'}${i.note ? ` · ${i.note}` : ''}`)
  ].join('\n')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 120_000)
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: process.env.HOME ?? '/',
    model: settings.model,
    maxTurns: 3,
    allowedTools: [],
    canUseTool: async (tool) => ({ behavior: 'deny', message: `${tool} is not needed; answer from the inventory.` }),
    abortController: abort,
    settingSources: [],
    outputFormat: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> },
    env: { ...process.env, ...accountEnv(undefined) },
    stderr: (d) => console.error('[crew suggest]', d.trimEnd())
  }
  let structured: unknown
  try {
    for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId: spaceId ?? '', accountId: defaultAccountId('anthropic') ?? 'default', kind: 'suggest' }))
        } catch {
          /* ledger must never break the suggestion */
        }
        if (msg.subtype === 'success') structured = msg.structured_output
        else throw new Error(`Suggestion ended with ${msg.subtype}${'errors' in msg && Array.isArray(msg.errors) ? `: ${(msg.errors as string[]).join('; ')}` : ''}`)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  const s = (structured ?? {}) as Partial<CrewSuggestion>
  const known = new Set(inv.map((i) => i.ref))
  const fix = (ref: string): string => (known.has(ref) ? ref : (inv.find((i) => i.ref.endsWith(`/${ref}`) || classifyModel(i.ref).modelId === ref)?.ref ?? ref))
  return {
    orchestrator: { model: fix(s.orchestrator?.model ?? orchestratorNow), why: s.orchestrator?.why ?? '' },
    agents: (s.agents ?? []).filter((a) => crew.some((c) => c.id === a.id)).map((a) => ({ id: a.id, name: crew.find((c) => c.id === a.id)!.name, model: fix(a.model), effort: a.effort, why: a.why })),
    notes: s.notes
  }
}


// ---------- instant preset ----------

type Role = 'explorer' | 'tester' | 'implementer' | 'reviewer' | 'other'
function roleOf(a: AgentSpec): Role {
  const t = `${a.name} ${a.description}`.toLowerCase()
  if (/explor|search|research|read|investigat|scout/.test(t)) return 'explorer'
  if (/test|qa|verify|check|lint|typecheck/.test(t)) return 'tester'
  if (/review|audit|critic/.test(t)) return 'reviewer'
  if (/implement|build|code|write|fix|develop|engineer/.test(t)) return 'implementer'
  return 'other'
}
const PRESET: Record<CrewPriority, { orchestrator: string; roles: Record<Role, { model: string; effort: AgentSpec['effort'] }>; why: Record<'orchestrator' | Role, string> }> = {
  cost: {
    orchestrator: 'sonnet',
    roles: { explorer: { model: 'haiku', effort: 'low' }, tester: { model: 'haiku', effort: 'low' }, implementer: { model: 'sonnet', effort: 'medium' }, reviewer: { model: 'sonnet', effort: 'medium' }, other: { model: 'haiku', effort: 'low' } },
    why: { orchestrator: 'Sonnet plans and integrates well enough for most tasks at a fraction of Opus.', explorer: 'Reading many files is volume work; Haiku at low effort is the cheapest that does it reliably.', tester: 'Running and reading tests needs speed, not judgment.', implementer: 'Sonnet is a strong coder; medium effort keeps it from over-thinking small changes.', reviewer: 'Sonnet catches the common mistakes; escalate to Opus by hand for risky diffs.', other: 'Cheapest capable model for an auxiliary role.' }
  },
  balanced: {
    orchestrator: 'opus',
    roles: { explorer: { model: 'haiku', effort: 'medium' }, tester: { model: 'haiku', effort: 'medium' }, implementer: { model: 'sonnet', effort: 'high' }, reviewer: { model: 'opus', effort: 'high' }, other: { model: 'sonnet', effort: 'medium' } },
    why: { orchestrator: 'Opus for planning, integration and talking to you: the judgment role.', explorer: 'Exploration is high volume; Haiku is fast and cheap and good at finding things.', tester: 'Test runs need speed and accurate reading of output, not deep reasoning.', implementer: 'Sonnet at high effort writes solid code without Opus prices.', reviewer: 'Review is where care pays off; Opus with high effort.', other: 'Sonnet as the sensible middle.' }
  },
  quality: {
    orchestrator: 'fable',
    roles: { explorer: { model: 'sonnet', effort: 'medium' }, tester: { model: 'sonnet', effort: 'medium' }, implementer: { model: 'opus', effort: 'high' }, reviewer: { model: 'fable', effort: 'max' }, other: { model: 'opus', effort: 'high' } },
    why: { orchestrator: 'The strongest model available drives the plan and the integration.', explorer: 'Sonnet reads code more carefully than Haiku when accuracy matters more than cost.', tester: 'Sonnet interprets failing tests and flaky output more reliably.', implementer: 'Opus at high effort for the changes themselves.', reviewer: 'The most careful reviewer at maximum effort; the last line of defence.', other: 'Opus for anything unusual.' }
  }
}

/** A suggestion computed locally in a millisecond, for Claude Code crews; the model-based one refines it afterwards. */
export async function preset(spaceId: string | undefined, priority: CrewPriority = 'balanced'): Promise<CrewSuggestion | null> {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  const engine: Engine = space?.engine ?? settings.engine ?? 'claude-code'
  if (engine !== 'claude-code') return null
  const crew: AgentSpec[] = space?.agents ?? settings.agents
  const inv = await inventory(false)
  const available = new Set(inv.filter((i) => i.available).map((i) => i.ref))
  const pick = (m: string): string => (available.has(m) ? m : available.has('opus') && m === 'fable' ? 'opus' : m)
  const p = PRESET[priority]
  return {
    orchestrator: { model: pick(p.orchestrator), why: p.why.orchestrator },
    agents: crew.map((a) => {
      const r = roleOf(a)
      return { id: a.id, name: a.name, model: pick(p.roles[r].model), effort: p.roles[r].effort, why: p.why[r] }
    }),
    notes: priority === 'cost' ? 'Cost preset: no Opus anywhere. Pair it with Budget mode on the space for the full effect.' : priority === 'quality' ? 'Quality preset: expect several times the spend of Balanced.' : undefined
  }
}
