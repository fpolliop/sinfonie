/**
 * Keeps the document's theme in step with Preferences (System / Light / Dark) and the lens: unset means light in
 * guided mode and dark in expert mode. System follows macOS live. Separate from lib/theme.ts, which the app store
 * imports, so the store and the theme never import each other.
 */
import { useEffect } from 'react'
import { useApp } from '@/stores/app'
import { applyTheme, resolveTheme, type ThemeName } from './theme'

const KEY = 'sinfonie.theme'
// The last theme drawn, applied before settings load, so a light-theme start never flashes dark.
try {
  const last = localStorage.getItem(KEY)
  if (last === 'light' || last === 'dark') applyTheme(last)
} catch {
  /* storage unavailable */
}

export function useThemeSync(): void {
  const pref = useApp((s) => s.settings.theme)
  const guided = useApp((s) => s.settings.mode === 'guided')
  const loaded = useApp((s) => s.loaded)
  useEffect(() => {
    if (!loaded) return
    const apply = (name: ThemeName): void => {
      applyTheme(name)
      try {
        localStorage.setItem(KEY, name)
      } catch {
        /* storage unavailable */
      }
    }
    apply(resolveTheme(pref, guided))
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => apply(resolveTheme('system', guided))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref, guided, loaded])
}
