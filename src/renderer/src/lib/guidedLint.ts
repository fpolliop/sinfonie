/**
 * Development guardrail for guided mode: while the app is in guided mode, watch the visible text and warn when an
 * expert word or a raw error reaches the screen. Development builds only; production never loads this module.
 *
 * Text inside an element marked `data-expert-ok` (for example "Show technical details" disclosures the person opened
 * on purpose) is ignored, as are inputs, code the person typed, and the xterm/CodeMirror surfaces.
 */
import { isGuided } from '@/lib/guided'

const DENY: [RegExp, string][] = [
  [/\bbranch(es)?\b/i, 'branch'],
  [/\bworktrees?\b/i, 'worktree'],
  [/\brepo(sitor(y|ies))?s?\b/i, 'repo'],
  [/\bcommit(s|ted)?\b/i, 'commit'],
  [/\bpush(ed)?\b/i, 'push'],
  [/\bpull requests?\b|\bPRs?\b/, 'pull request'],
  [/\bCLI\b/, 'CLI'],
  [/\bMCP\b/, 'MCP'],
  [/\bAPI key\b/i, 'API key'],
  [/\blocalhost\b/i, 'localhost'],
  [/\bClaude Code\b/, 'Claude Code'],
  [/\bTXT record\b/i, 'TXT record'],
  [/(^|\s)\/Users\/\S+/, 'absolute path'],
  [/\bError: |\bat \S+ \(.*:\d+:\d+\)/, 'raw error']
]

const SKIP = 'input, textarea, [contenteditable], .xterm, .cm-editor, [data-expert-ok]'

function scan(root: HTMLElement, seen: Set<string>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    const text = n.textContent?.trim()
    if (!el || !text || el.closest(SKIP) || el.offsetParent === null) continue
    for (const [re, name] of DENY) {
      if (!re.test(text)) continue
      const key = `${name}:${text.slice(0, 80)}`
      if (seen.has(key)) continue
      seen.add(key)
      el.style.outline = '2px dashed #ff6b6b'
      console.warn(`[guided-lint] "${name}" visible in guided mode:`, JSON.stringify(text.slice(0, 160)), el)
    }
  }
}

export function startGuidedLint(): void {
  const root = document.getElementById('root')
  if (!root) return
  const seen = new Set<string>()
  let queued = false
  const run = (): void => {
    queued = false
    if (isGuided()) scan(root, seen)
  }
  new MutationObserver(() => {
    if (queued) return
    queued = true
    setTimeout(run, 500)
  }).observe(root, { subtree: true, childList: true, characterData: true })
}
