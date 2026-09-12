/** Design tokens shared by every screen: the same palette as the Mac app and sinfonie.dev. */
import type { ViewStyle } from 'react-native'

export const C = {
  bg: '#0b0d11',
  bg2: '#0f1115',
  panel: '#12151b',
  panel2: '#1b2030',
  panel3: '#232a38',
  border: '#232a38',
  border2: '#2d3546',
  text: '#e8eaf0',
  muted: '#8f97a8',
  dim: '#5f6779',
  accent: '#7c9cff',
  accent2: '#5b7cff',
  violet: '#a78bfa',
  pink: '#f472b6',
  ok: '#4ade80',
  warn: '#fbbf24',
  danger: '#f87171'
}
export const gradient = ['#5b7cff', '#7c9cff'] as const
export const brandGradient = ['#7c9cff', '#a78bfa', '#f472b6'] as const
/** Max width of the content column; on a wide screen (iPad) content centers instead of stretching. */
export const MAX_W = 760
/**
 * Caps a scrollable to a centered column on wide screens. Applied to the list/scroll `style` (its frame),
 * NOT its contentContainerStyle — alignment props on a VirtualizedList's content container corrupt its
 * scroll metrics (jumps to top on update). No-op on phones, where the screen is narrower than MAX_W.
 */
export const pane: ViewStyle = { flex: 1, width: '100%', maxWidth: MAX_W, alignSelf: 'center' }
export const R = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 }
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 }
export const T = {
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5, color: C.text },
  h1: { fontSize: 20, fontWeight: '700' as const, letterSpacing: -0.3, color: C.text },
  h2: { fontSize: 16, fontWeight: '600' as const, color: C.text },
  body: { fontSize: 15, lineHeight: 21, color: C.text },
  small: { fontSize: 13, lineHeight: 18, color: C.muted },
  caption: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.6, textTransform: 'uppercase' as const, color: C.dim },
  mono: { fontFamily: 'Menlo', fontSize: 12.5, lineHeight: 18, color: C.text }
}
export const mono = { fontFamily: 'Menlo' }
export const shadow = { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8 }
