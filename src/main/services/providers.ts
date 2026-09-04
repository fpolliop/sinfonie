import { safeStorage } from 'electron'
import { nanoid } from 'nanoid'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { ProviderConfig, ProviderKind } from '@shared/types'
import { PROVIDER_KINDS, parseModelRef } from '@shared/types'
import { getStore } from '../store'

function encrypt(text: string): string {
  return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(text).toString('base64') : 'plain:' + Buffer.from(text, 'utf8').toString('base64')
}
function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}
const keyName = (id: string): string => `provider:${id}:key`

export function listProviders(): ProviderConfig[] {
  return getStore().get().settings.providers ?? []
}

export function getProvider(id: string): ProviderConfig {
  const p = listProviders().find((x) => x.id === id)
  if (!p) throw new Error(`Unknown provider ${id}`)
  return p
}

function apiKeyFor(id: string): string | undefined {
  const raw = getStore().get().secrets?.[keyName(id)]
  return raw ? decrypt(raw) : undefined
}

export function addProvider(cfg: { kind: ProviderKind; name: string; baseUrl?: string; apiKey?: string }): ProviderConfig {
  const kind = PROVIDER_KINDS.find((k) => k.id === cfg.kind)
  if (!kind) throw new Error('Unknown provider kind')
  const p: ProviderConfig = { id: nanoid(6), kind: cfg.kind, name: cfg.name.trim() || kind.label, baseUrl: (cfg.baseUrl?.trim() || kind.baseUrl || undefined)?.replace(/\/+$/, ''), hasKey: Boolean(cfg.apiKey?.trim()) }
  getStore().update((d) => {
    d.settings.providers = [...(d.settings.providers ?? []), p]
    if (cfg.apiKey?.trim()) {
      d.secrets = d.secrets ?? {}
      d.secrets[keyName(p.id)] = encrypt(cfg.apiKey.trim())
    }
  })
  return p
}

export function updateProvider(id: string, patch: { name?: string; baseUrl?: string; apiKey?: string }): ProviderConfig {
  let out: ProviderConfig | undefined
  getStore().update((d) => {
    const p = (d.settings.providers ?? []).find((x) => x.id === id)
    if (!p) return
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name
    if (patch.baseUrl !== undefined) p.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '') || undefined
    if (patch.apiKey !== undefined) {
      d.secrets = d.secrets ?? {}
      if (patch.apiKey.trim()) {
        d.secrets[keyName(id)] = encrypt(patch.apiKey.trim())
        p.hasKey = true
      } else {
        delete d.secrets[keyName(id)]
        p.hasKey = false
      }
    }
    out = p
  })
  if (!out) throw new Error(`Unknown provider ${id}`)
  return out
}

export function removeProvider(id: string): void {
  getStore().update((d) => {
    d.settings.providers = (d.settings.providers ?? []).filter((x) => x.id !== id)
    if (d.secrets) delete d.secrets[keyName(id)]
  })
}

/** The stored key of the first provider of a kind, for engines that take it from the environment (Gemini CLI). */
export function apiKeyForKind(kind: ProviderKind): string | undefined {
  const p = listProviders().find((x) => x.kind === kind && x.hasKey)
  return p ? apiKeyFor(p.id) : undefined
}

/** An AI SDK language model for "<providerId>/<modelId>". */
export function resolveModel(ref: string): LanguageModel {
  const parsed = parseModelRef(ref)
  if (!parsed) throw new Error(`Model "${ref}" must be "<provider>/<model>" for the native engine. Pick one in the space settings.`)
  const p = getProvider(parsed.providerId)
  const apiKey = apiKeyFor(p.id)
  switch (p.kind) {
    case 'anthropic':
      return createAnthropic({ apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) })(parsed.modelId)
    case 'openai':
      return createOpenAI({ apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) })(parsed.modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) })(parsed.modelId)
    case 'deepseek':
      return createDeepSeek({ apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) })(parsed.modelId)
    case 'ollama':
    case 'lmstudio':
    case 'openai-compatible':
      return createOpenAICompatible({ name: p.name, baseURL: p.baseUrl ?? 'http://localhost:11434/v1', ...(apiKey ? { apiKey } : {}) })(parsed.modelId)
  }
}

/** Ask the provider which models it offers; cache on the config for the pickers. */
export async function fetchModels(id: string): Promise<string[]> {
  const p = getProvider(id)
  const apiKey = apiKeyFor(id)
  let models: string[] = []
  const headers: Record<string, string> = {}
  let url: string
  if (p.kind === 'anthropic') {
    url = `${p.baseUrl ?? 'https://api.anthropic.com'}/v1/models?limit=100`
    headers['x-api-key'] = apiKey ?? ''
    headers['anthropic-version'] = '2023-06-01'
  } else if (p.kind === 'google') {
    url = `${p.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}/models?pageSize=200&key=${encodeURIComponent(apiKey ?? '')}`
  } else if (p.kind === 'deepseek') {
    url = `${p.baseUrl ?? 'https://api.deepseek.com'}/models`
    headers.Authorization = `Bearer ${apiKey ?? ''}`
  } else if (p.kind === 'openai') {
    url = `${p.baseUrl ?? 'https://api.openai.com/v1'}/models`
    headers.Authorization = `Bearer ${apiKey ?? ''}`
  } else {
    url = `${p.baseUrl ?? 'http://localhost:11434/v1'}/models`
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  }
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${p.name}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const j = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] }
  if (p.kind === 'google') models = (j.models ?? []).map((m) => m.name.replace(/^models\//, '')).filter((n) => /gemini/.test(n))
  else models = (j.data ?? []).map((m) => m.id)
  models = Array.from(new Set(models)).sort()
  getStore().update((d) => {
    const x = (d.settings.providers ?? []).find((y) => y.id === id)
    if (x) {
      x.models = models
      x.modelsFetchedAt = new Date().toISOString()
    }
  })
  return models
}

/** Rough USD cost per million tokens for well-known models; unknown models report 0 and show tokens only. */
const PRICES: [RegExp, number, number][] = [
  [/fable-5/, 10, 50],
  [/opus-5|opus-4-8|opus-4-7|opus-4-6/, 5, 25],
  [/sonnet-5/, 2, 10],
  [/sonnet-4-6/, 3, 15],
  [/haiku-4-5/, 1, 5],
  [/gpt-5\.?1|gpt-5(?!-mini|-nano)/, 1.25, 10],
  [/gpt-5-mini/, 0.25, 2],
  [/gpt-5-nano/, 0.05, 0.4],
  [/gpt-4\.1(?!-mini|-nano)/, 2, 8],
  [/gpt-4\.1-mini/, 0.4, 1.6],
  [/gemini-2\.5-pro|gemini-3.*pro/, 1.25, 10],
  [/gemini-2\.5-flash|gemini-3.*flash/, 0.3, 2.5],
  [/deepseek-chat|deepseek-v3/, 0.27, 1.1],
  [/deepseek-reasoner|deepseek-r1/, 0.55, 2.19]
]
export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const hit = PRICES.find(([re]) => re.test(modelId))
  if (!hit) return 0
  return (inputTokens * hit[1] + outputTokens * hit[2]) / 1_000_000
}
