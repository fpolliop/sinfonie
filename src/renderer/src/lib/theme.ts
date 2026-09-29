/**
 * The app's colour tokens as literal values, for the places that cannot read CSS variables (CodeMirror themes,
 * xterm, SVG attributes). They mirror `--color-*` in index.css; change both together.
 */
export const tokens = {
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
} as const

/** Syntax-highlight hues for the code editor; the ones that match a token reuse it. */
export const syntax = {
  keyword: '#a78bfa',
  string: tokens.ok,
  literal: tokens.warn,
  regexp: '#f472b6',
  comment: tokens.muted,
  type: tokens.accent,
  definition: '#f472b6',
  property: '#c7cede',
  invalid: tokens.danger,
  heading: tokens.text
} as const
