/**
 * Display names shared by guided and expert surfaces: what a repository, a task and a sign-in vendor are called
 * on screen. The stored values (repo slug, branch) stay as they are; only what a person reads changes.
 */
import type { Repo, Vendor, Workspace } from '@shared/types'
import { VENDORS } from '@shared/types'

/** A repository as a person calls it: the friendly name set in Guided setup, else the folder name read as words. */
export function repoLabel(repo: Pick<Repo, 'name' | 'displayName'> | undefined | null): string {
  if (!repo) return ''
  return repo.displayName?.trim() || humanName(repo.name)
}

/** A folder name read as words: "shop-website" → "Shop website", "api_v2" → "Api v2". */
export function humanName(name: string): string {
  const words = name.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

/**
 * A human title from a free-text request: first line, collapsed spaces, sentence case, cut at a word boundary
 * near `max` characters. "make the add-to-cart button BIGGER on mobile" -> "Make the add-to-cart button BIGGER on mobile".
 */
export function humanTitle(text: string, max = 60): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  let out = line.replace(/\s+/g, ' ').trim()
  if (out.length > max) {
    const cut = out.slice(0, max)
    const space = cut.lastIndexOf(' ')
    out = (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '') + '…'
  }
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/**
 * A workspace's name as shown. Guided mode turns an old kebab slug ("make-cart-button-bigger") into words
 * ("Make cart button bigger"); names that already read as words are left alone.
 */
export function workspaceLabel(ws: Pick<Workspace, 'name'> | undefined | null, guided: boolean): string {
  if (!ws) return ''
  const name = ws.name
  if (!guided || !/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(name)) return name
  const words = name.replace(/[-_]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** What a guided user signs in with, per vendor: the product they pay for, never the CLI behind it. */
const GUIDED_VENDOR: Partial<Record<Vendor, { name: string; hint: string }>> = {
  anthropic: { name: 'Claude', hint: 'Sign in with your Claude account (Pro or Max).' },
  openai: { name: 'ChatGPT', hint: 'Sign in with your ChatGPT account (Plus, Pro or Team).' },
  xai: { name: 'Grok', hint: 'Sign in with your SuperGrok account.' }
}

/** Vendors a guided user can sign in to from the app (browser sign-in only; no API keys). */
export const GUIDED_VENDORS = VENDORS.filter((v) => GUIDED_VENDOR[v.id])

/** The sign-in name of a vendor: "Claude" in guided mode, "Claude Code" in expert mode. */
export function vendorLabel(vendor: Vendor | undefined, guided: boolean): string {
  const v = VENDORS.find((x) => x.id === (vendor ?? 'anthropic'))
  if (guided) return GUIDED_VENDOR[vendor ?? 'anthropic']?.name ?? v?.label ?? ''
  return v?.agent ?? ''
}

export function guidedVendorHint(vendor: Vendor): string {
  return GUIDED_VENDOR[vendor]?.hint ?? ''
}
