import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSpec, CrewSuggestion, Engine, ModelInventoryItem } from '@shared/types'
import { ACP_ENGINES, CLAUDE_MODELS, PROVIDER_KINDS, classifyModel } from '@shared/types'
import { getStore } from '../../store'
import { accountEnv } from '../accounts'
import { probeCache, probe } from '../acp/engine'
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
  for (const e of ACP_ENGINES) {
    const acc = settings.claudeAccounts.find((a) => a.vendor === (e.id === 'codex' ? 'openai' : e.id === 'gemini' ? 'google' : 'xai') && a.loggedIn)
    let pr = probeCache[e.id]
    if (!pr && refresh && (acc || e.id === 'gemini')) pr = await probe(e.id).catch(() => undefined)
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
export async function suggest(spaceId?: string): Promise<CrewSuggestion> {
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
    'Principles: the orchestrator needs the strongest judgment available (planning, integration, talking to the user). Exploration and test-running are high-volume and should use the cheapest capable model. Implementation needs a strong coding model. Review needs the most careful model. Prefer models included in a subscription the user already pays for (Claude login, vendor agents marked "subscription") over per-token API keys when quality is similar; use local models only for cheap read-only work unless nothing else is available. Mixing vendors is fine and often good: a different vendor for review catches different mistakes.',
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
