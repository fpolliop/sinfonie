import { safeStorage } from 'electron'
import type { JiraIssue, Settings } from '@shared/types'
import { getStore } from '../store'

function encrypt(token: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(token).toString('base64')
  return 'plain:' + Buffer.from(token, 'utf8').toString('base64')
}

function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}

export function saveToken(token: string): Settings {
  return getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (token.trim()) {
      d.secrets.jiraToken = encrypt(token.trim())
      d.settings.jira.hasToken = true
    } else {
      delete d.secrets.jiraToken
      d.settings.jira.hasToken = false
    }
  }).settings
}

function client(): { base: string; headers: Record<string, string> } {
  const { settings, secrets } = getStore().get()
  const { siteUrl, email } = settings.jira
  if (!siteUrl || !email || !secrets?.jiraToken) throw new Error('Jira is not configured. Add site URL, email and API token in Settings.')
  const base = siteUrl.replace(/\/+$/, '')
  const auth = Buffer.from(`${email}:${decrypt(secrets.jiraToken)}`, 'utf8').toString('base64')
  return { base, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
}

async function get<T>(path: string): Promise<T> {
  const { base, headers } = client()
  const res = await fetch(`${base}${path}`, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Jira ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  return (await res.json()) as T
}

interface RawIssue {
  key: string
  fields: {
    summary?: string
    status?: { name?: string }
    issuetype?: { name?: string }
    priority?: { name?: string }
    assignee?: { displayName?: string } | null
    updated?: string
    description?: unknown
  }
}

function toIssue(base: string, r: RawIssue): JiraIssue {
  return {
    key: r.key,
    summary: r.fields.summary ?? '',
    status: r.fields.status?.name ?? '',
    type: r.fields.issuetype?.name ?? '',
    priority: r.fields.priority?.name,
    assignee: r.fields.assignee?.displayName ?? undefined,
    updated: r.fields.updated,
    url: `${base}/browse/${r.key}`
  }
}

const FIELDS = 'summary,status,issuetype,priority,assignee,updated'

/** Empty query lists the configured default JQL; an issue key looks it up; anything else is a text search. */
export async function search(query: string): Promise<JiraIssue[]> {
  const q = query.trim()
  const { settings } = getStore().get()
  let jql: string
  if (!q) jql = settings.jira.defaultJql
  else if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(q)) jql = `key = "${q.toUpperCase()}"`
  else jql = `text ~ "${q.replace(/"/g, '\\"')}*" AND statusCategory != Done ORDER BY updated DESC`
  const { base } = client()
  const data = await get<{ issues: RawIssue[] }>(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&maxResults=30`)
  return (data.issues ?? []).map((r) => toIssue(base, r))
}

export async function issue(key: string): Promise<JiraIssue> {
  const { base } = client()
  const r = await get<RawIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS},description`)
  return { ...toIssue(base, r), description: adfToText(r.fields.description) }
}

/** Atlassian Document Format -> readable plain text. Good enough for a prompt. */
export function adfToText(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> }
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'hardBreak') return '\n'
  if (n.type === 'mention') return `@${String(n.attrs?.text ?? '')}`
  if (n.type === 'inlineCard') return String(n.attrs?.url ?? '')
  const children = (n.content ?? []).map((c) => adfToText(c, depth + 1))
  switch (n.type) {
    case 'paragraph':
      return children.join('') + '\n'
    case 'heading':
      return `\n${'#'.repeat(Number(n.attrs?.level ?? 1))} ${children.join('')}\n`
    case 'bulletList':
    case 'orderedList':
      return children.join('')
    case 'listItem':
      return `- ${children.join('').trim()}\n`
    case 'codeBlock':
      return `\n\`\`\`\n${children.join('')}\n\`\`\`\n`
    case 'blockquote':
      return children.map((c) => `> ${c}`).join('')
    case 'rule':
      return '\n---\n'
    default:
      return children.join('')
  }
}
