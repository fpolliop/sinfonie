/**
 * The app's colour tokens as literal values, for the places that cannot read CSS variables (xterm, colour maths).
 * They mirror `--color-*` in index.css; change both together. Two lenses: dark (expert default) and light (guided
 * default), docs/design/README.md §7. Where CSS is accepted (CodeMirror themes, SVG styles), prefer `vars`, which
 * follow the theme without re-rendering.
 */
export type ThemeName = 'dark' | 'light'
/** The person's choice under Preferences; unset means "the lens's default" (light for guided, dark for expert). */
type ThemePref = 'system' | 'light' | 'dark'

const darkTokens = {
  bg: '#0f1115',
  panel: '#161920',
  panel2: '#1c2027',
  border: '#262b35',
  sunken: '#0b0d11',
  text: '#e6e8ec',
  muted: '#8b93a1',
  /** Dimmer than muted: gutters and line numbers. */
  faint: '#5f6776',
  accent: '#7c9cff',
  maestro: '#c9b6ff',
  danger: '#ff6b6b',
  ok: '#4ade80',
  warn: '#fbbf24',
  /** Accent with alpha, for selections and matches. */
  accentSelection: 'rgba(124,156,255,0.25)',
  accentMatch: 'rgba(124,156,255,0.18)',
  accentOutline: 'rgba(124,156,255,0.4)',
  activeLine: 'rgba(255,255,255,0.03)'
}

const lightTokens: typeof darkTokens = {
  bg: '#f6f5f2',
  panel: '#ffffff',
  panel2: '#f1f0ec',
  border: '#dedbd4',
  sunken: '#efede8',
  text: '#1b1c20',
  muted: '#55585f',
  faint: '#7b7e85',
  accent: '#3b57d4',
  maestro: '#5b3fc4',
  danger: '#b42318',
  ok: '#137a4b',
  warn: '#9a5200',
  accentSelection: 'rgba(59,87,212,0.18)',
  accentMatch: 'rgba(59,87,212,0.12)',
  accentOutline: 'rgba(59,87,212,0.45)',
  activeLine: 'rgba(0,0,0,0.035)'
}

/** The current theme's literal values; updated in place when the theme changes (read them at use time). */
export const tokens: typeof darkTokens = { ...darkTokens }

/** The same tokens as CSS variables: they follow the theme live, for CSS-in-JS (CodeMirror) and SVG styles. */
export const vars = {
  bg: 'var(--color-bg)',
  panel: 'var(--color-panel)',
  panel2: 'var(--color-panel-2)',
  border: 'var(--color-border)',
  sunken: 'var(--color-sunken)',
  text: 'var(--color-text)',
  muted: 'var(--color-muted)',
  faint: 'var(--color-faint)',
  accent: 'var(--color-accent)',
  maestro: 'var(--color-maestro)',
  danger: 'var(--color-danger)',
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  accentSelection: 'var(--color-selection)',
  accentMatch: 'var(--color-match)',
  accentOutline: 'var(--color-match-outline)',
  activeLine: 'var(--color-active-line)'
} as const

/** Syntax-highlight hues for the code editor, per theme through CSS variables (index.css `--syn-*`). */
export const syntax = {
  keyword: 'var(--syn-keyword)',
  string: 'var(--syn-string)',
  literal: 'var(--syn-literal)',
  regexp: 'var(--syn-regexp)',
  comment: 'var(--syn-comment)',
  type: 'var(--syn-type)',
  definition: 'var(--syn-definition)',
  property: 'var(--syn-property)',
  invalid: 'var(--syn-invalid)',
  heading: 'var(--syn-heading)'
} as const

/** xterm's palette per theme: the ANSI colours are tuned so every one reads on the terminal's ground. */
export function terminalTheme(): Record<string, string> {
  const t = tokens
  const base = { background: t.sunken, foreground: t.text, cursor: t.accent, cursorAccent: t.sunken, selectionBackground: t.accentSelection }
  if (current === 'dark') return { ...base, black: t.panel2, brightBlack: t.faint }
  return {
    ...base,
    black: '#1b1c20',
    red: '#b42318',
    green: '#137a4b',
    yellow: '#8a5a00',
    blue: '#3b57d4',
    magenta: '#8a3fb8',
    cyan: '#0f6f7a',
    white: '#6b6e75',
    brightBlack: '#55585f',
    brightRed: '#c4321f',
    brightGreen: '#1a8a57',
    brightYellow: '#9a5200',
    brightBlue: '#324cc0',
    brightMagenta: '#9d4bc9',
    brightCyan: '#137f8b',
    brightWhite: '#3a3c42'
  }
}

let current: ThemeName = 'dark'
const listeners = new Set<(t: ThemeName) => void>()

export const currentTheme = (): ThemeName => current

/** Which lens to draw: the person's choice, else light for guided and dark for expert; System follows macOS. */
export function resolveTheme(pref: ThemePref | undefined, guided: boolean): ThemeName {
  const p = pref ?? (guided ? 'light' : 'dark')
  if (p === 'system') return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  return p
}

/** Switch the document to a theme: CSS tokens via data-theme, literal tokens in place, then tell listeners. */
export function applyTheme(name: ThemeName): void {
  const root = document.documentElement
  root.dataset.theme = name
  root.style.colorScheme = name
  // theme-boot.js painted the ground before the stylesheet; body's background takes over from here.
  root.style.background = ''
  Object.assign(tokens, name === 'light' ? lightTokens : darkTokens)
  if (name === current) return
  current = name
  for (const l of listeners) l(name)
}

export function onThemeChange(fn: (t: ThemeName) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
