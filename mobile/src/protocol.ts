/**
 * The wire protocol shared with the Mac app (src/shared/types.ts in the desktop repo): the same
 * message shapes, the same key derivation, the same AES-GCM envelopes. Pure JS crypto from noble,
 * because Hermes has no SubtleCrypto.
 */
import { gcm } from '@noble/ciphers/aes.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { bytesToUtf8 } from '@noble/ciphers/utils.js'
import * as Crypto from 'expo-crypto'

// ---- shapes mirrored from the desktop ----
export type ChatRole = 'user' | 'assistant' | 'system'
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; image: { id: string; name: string; mimeType: string; path: string; url: string } }
  | { type: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean; done: boolean; sub?: { model?: string; toolCalls: number; lastTool?: string; text?: string } }
export interface ChatItem {
  id: string
  role: ChatRole
  blocks: ChatBlock[]
  createdAt: string
  level?: 'info' | 'warn' | 'error'
}
export interface RemoteWorkspace {
  id: string
  name: string
  space?: { name: string; color: string }
  stage: 'todo' | 'in-progress' | 'in-review' | 'done'
  status: 'creating' | 'ready' | 'error' | 'archiving' | 'archived'
  busy: boolean
  needsInput: boolean
  /** The agent replied and it is your move (assistant spoke last, nothing running, no open prompt). */
  awaitingReply?: boolean
  lastMessageAt?: string
  lastText?: string
}
export interface PermissionRequest {
  requestId: string
  workspaceId: string
  toolName: string
  input: Record<string, unknown>
  blockedPath?: string
  canAlwaysAllow: boolean
}
export interface QuestionOption {
  label: string
  description: string
  preview?: string
}
export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}
export interface QuestionRequest {
  requestId: string
  workspaceId: string
  questions: Question[]
}
export type RemotePrompt = { kind: 'permission'; request: PermissionRequest } | { kind: 'question'; request: QuestionRequest }
export interface RemoteSpace {
  id: string
  name: string
  color: string
  repoCount: number
}
export interface RemoteReviewPr {
  nameWithOwner: string
  number: number
  title: string
  author: string
  url: string
  updatedAt: string
  isDraft: boolean
  space?: { name: string; color: string }
}
// ---- on-call (incident triage) ----
export type IncidentStatus = 'new' | 'triaging' | 'open' | 'waiting' | 'resolved' | 'dismissed'
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export interface ProposedFix {
  repo: string
  summary: string
  changes: string[]
  risks: string
}
export interface TriageReport {
  summary: string
  severity: Severity
  category: 'customer' | 'bug' | 'infra' | 'question' | 'noise'
  likelyCause: string
  evidence: string[]
  nextSteps: string[]
  customerReply?: string
  needsHuman: boolean
  confidence: 'low' | 'medium' | 'high'
  proposedFix?: ProposedFix
}
export interface IncidentFix {
  status: 'running' | 'done' | 'failed'
  phase?: string
  branch?: string
  prUrl?: string
  commit?: string
  error?: string
  costUsd?: number
  startedAt: string
  finishedAt?: string
}
export interface RemoteIncidentProposal {
  id: string
  text: string
  status: 'proposed' | 'sent' | 'dismissed'
}
export interface RemoteIncidentMessage {
  user: string
  text: string
  at: string
}
export interface RemoteIncident {
  id: string
  space?: { name: string; color: string }
  channelName: string
  kind: 'support' | 'alerts'
  title: string
  status: IncidentStatus
  severity?: Severity
  permalink?: string
  occurrences?: number
  needsHuman: boolean
  costUsd: number
  createdAt: string
  updatedAt: string
  report?: TriageReport
  fix?: IncidentFix
  proposals: RemoteIncidentProposal[]
  messages: RemoteIncidentMessage[]
  notes: { at: string; role: string; text: string }[]
}
export type ToPhone =
  | { type: 'hello'; host: string; version: string }
  | { type: 'workspaces'; items: RemoteWorkspace[] }
  | { type: 'spaces'; items: RemoteSpace[] }
  | { type: 'created'; workspaceId: string }
  | { type: 'reviews'; items: RemoteReviewPr[] }
  | { type: 'oncall'; items: RemoteIncident[]; running: boolean }
  | { type: 'transcript'; workspaceId: string; items: ChatItem[]; hasMore: boolean }
  | { type: 'history'; workspaceId: string; items: ChatItem[]; hasMore: boolean }
  | { type: 'item'; workspaceId: string; item: ChatItem }
  | { type: 'busy'; workspaceId: string; busy: boolean }
  | { type: 'prompts'; items: RemotePrompt[] }
  | { type: 'prompt'; prompt: RemotePrompt }
  | { type: 'prompt:resolved'; requestId: string }
  | { type: 'error'; workspaceId?: string; message: string }
export type FromPhone =
  | { type: 'sync' }
  | { type: 'subscribe'; workspaceId: string }
  | { type: 'unsubscribe'; workspaceId: string }
  | { type: 'history'; workspaceId: string; beforeId: string }
  | { type: 'send'; workspaceId: string; text: string }
  | { type: 'interrupt'; workspaceId: string }
  | { type: 'create'; spaceId?: string; name?: string; text: string }
  | { type: 'reviews' }
  | { type: 'oncall' }
  | { type: 'oncall:setStatus'; id: string; status: IncidentStatus }
  | { type: 'oncall:setSeverity'; id: string; severity: Severity }
  | { type: 'oncall:approve'; id: string; proposalId: string }
  | { type: 'oncall:dismissProposal'; id: string; proposalId: string }
  | { type: 'permission'; requestId: string; decision: 'allow' | 'always' | 'deny' }
  | { type: 'question'; requestId: string; answers: Record<string, string>; response?: string }

// ---- pairing ----
export interface Pairing {
  k: string
  relay: string
  roomId: string
  auth: string
  key: Uint8Array
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function b64uDecode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 255)
    }
  }
  return Uint8Array.from(out)
}
export function b64uEncode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += B64[(acc >> bits) & 63]
    }
  }
  if (bits > 0) out += B64[(acc << (6 - bits)) & 63]
  return out
}
/** Accepts the QR/link content (https://sinfonie.dev/m/#k=…&relay=…) or a bare key. */
export function parsePairingLink(text: string): { k: string; relay: string } | null {
  const t = text.trim()
  const frag = t.includes('#') ? t.slice(t.indexOf('#') + 1) : t
  const params = new URLSearchParams(frag)
  const k = params.get('k') || (/^[A-Za-z0-9_-]{40,50}$/.test(t) ? t : null)
  if (!k || b64uDecode(k).length !== 32) return null
  return { k, relay: params.get('relay') || 'https://relay.sinfonie.dev' }
}
export function derive(k: string, relay: string): Pairing {
  const roomId = bytesToHex(sha256(utf8ToBytes('room:' + k))).slice(0, 32)
  const auth = bytesToHex(sha256(utf8ToBytes('auth:' + k)))
  return { k, relay, roomId, auth, key: b64uDecode(k) }
}
export const wsUrl = (p: Pairing): string => `${p.relay.replace(/^http/, 'ws')}/room/${p.roomId}/ws?role=phone&auth=${p.auth}`
export const sendUrl = (p: Pairing): string => `${p.relay}/room/${p.roomId}/send?auth=${p.auth}`

// ---- envelopes ----
export function seal(p: Pairing, msg: FromPhone): string {
  const iv = Crypto.getRandomValues(new Uint8Array(12))
  const ct = gcm(p.key, iv).encrypt(utf8ToBytes(JSON.stringify(msg)))
  return JSON.stringify({ iv: b64uEncode(iv), ct: b64uEncode(ct) })
}
export function unseal(p: Pairing, text: string): ToPhone {
  const { iv, ct } = JSON.parse(text) as { iv: string; ct: string }
  const pt = gcm(p.key, b64uDecode(iv)).decrypt(b64uDecode(ct))
  return JSON.parse(bytesToUtf8(pt)) as ToPhone
}
