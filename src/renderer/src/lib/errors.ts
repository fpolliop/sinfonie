/**
 * One place that turns a thrown value into words for a person. Expert mode keeps the real message (minus the
 * "Error:" prefix and IPC wrapper noise); guided mode gets a plain sentence and never sees git, paths or stacks.
 */
import { isGuided } from '@/lib/guided'

/** The raw message, cleaned of Electron's IPC wrapper and a leading "Error:". */
export function rawMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  return msg
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^(Uncaught\s+)?Error:\s*/, '')
    .trim()
}

const GUIDED_RULES: [RegExp, string][] = [
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
  if (!guided) return raw || fallback
  for (const [re, text] of GUIDED_RULES) if (re.test(raw)) return text
  return fallback
}
