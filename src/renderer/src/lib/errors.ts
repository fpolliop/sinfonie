/**
 * One place that turns a thrown value into words for a person. Expert mode keeps the real message (minus the
 * "Error:" prefix and IPC wrapper noise); guided mode gets a plain sentence and never sees git, paths or stacks.
 */
import { isGuided } from '@/lib/guided'
import { PLAIN_ERROR_MARK } from '@shared/types'
import { GITHUB_AUTH_RE } from '@/lib/github'

/** The raw message, cleaned of Electron's IPC wrapper and a leading "Error:". */
export function rawMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  // IPC rejections arrive as "Error: Error invoking remote method 'x': Error: …": peel every layer.
  const out = unwrap(msg)
  return out.startsWith(PLAIN_ERROR_MARK) ? out.slice(PLAIN_ERROR_MARK.length).trim() : out
}

function unwrap(msg: string): string {
  let out = msg.trim()
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = out
      .replace(/^(Uncaught\s+)?Error:\s*/, '')
      .replace(/^Error invoking remote method '[^']+':\s*/, '')
      .trim()
  }
  return out
}

/** Main wrote this message for the person already (PLAIN_ERROR_MARK): show it as is in either lens. */
export function isPlainError(err: unknown): boolean {
  return unwrap(err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)).startsWith(PLAIN_ERROR_MARK)
}

/** Plain words for "GitHub needs connecting". Screens that show this also offer <ConnectGitHubCard /> (needsGitHub). */
export const GITHUB_CONNECT_TEXT = 'Sinfonie needs your GitHub account for this. Connect GitHub, then try again.'

/** A git or GitHub failure fixed by connecting GitHub (not by any Settings page): show <ConnectGitHubCard />. */
export function needsGitHub(err: unknown): boolean {
  return GITHUB_AUTH_RE.test(rawMessage(err))
}

const GUIDED_RULES: [RegExp, string][] = [
  // GitHub and git sign-in problems first: they are fixed by Connect GitHub, never by Settings → Sign-in.
  [GITHUB_AUTH_RE, GITHUB_CONNECT_TEXT],
  [/rejected|non-fast-forward|fetch first|conflict/i, 'Someone else changed the same app in the meantime. Ask a teammate to help combine the changes.'],
  [/auth|permission denied|403|401|credential|not logged in|sign in/i, 'Sinfonie could not sign in to finish this. Check Settings → Sign-in, or ask a teammate.'],
  [/network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|offline/i, 'Sinfonie could not reach the internet. Check your connection and try again.'],
  [/nothing to commit|no changes/i, 'There are no changes to send yet.'],
  [/rate limit|quota|usage limit|429/i, 'Maestro has hit its usage limit for now. Try again later.'],
  [/ENOSPC|no space left/i, 'Your Mac is out of disk space. Free some up and try again.']
]

/** Guided: a plain sentence (with `fallback` when nothing specific matches). Expert: the cleaned raw message. */
export function friendlyError(err: unknown, fallback = 'Something went wrong. Try again, or ask a teammate.', guided = isGuided()): string {
  const raw = rawMessage(err)
  if (!guided || isPlainError(err)) return raw || fallback
  // Team guardrail refusals (src/main/services/team-rules.ts) are written for builders already.
  if (/^(Your team requires|Only a team admin|Today's spending limit|Only saved on this Mac)/.test(raw)) return raw
  for (const [re, text] of GUIDED_RULES) if (re.test(raw)) return text
  return fallback
}
