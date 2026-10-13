/**
 * Crash reporting from inside the page.
 *
 * Chromium's console line reaches the main process without a renderer stack: every report filed so
 * far names `preload/index.js` and nothing else, which is why a React update loop (error #185) could
 * not be traced to a component. The page therefore reports its own crashes here, with the real stack,
 * the screen it happened on, and the last calls and events it handled. The main process holds its own
 * bare console report briefly so this one replaces it (see services/telemetry.ts).
 */
import { useApp } from '@/stores/app'

export type CrashKind = 'uncaught' | 'rejection' | 'render'

const TRAIL = 20
const REPEAT_MS = 10_000

const trail: { step: string; n: number }[] = []
const sent = new Map<string, number>()

/**
 * Record one step — an IPC call or event — for the trail kept with the next crash report. Repeats
 * collapse into a count, so a loop shows up as one line with a large count instead of filling the trail.
 */
export function note(step: string): void {
  const last = trail[trail.length - 1]
  if (last && last.step === step) {
    last.n++
    return
  }
  trail.push({ step, n: 1 })
  if (trail.length > TRAIL) trail.shift()
}

/** Where the person was: the view, the open inspector tab, and the workspace if one is selected. */
function screen(): string {
  try {
    const { view, tab, selectedId } = useApp.getState()
    return `${view}${view === 'workspace' ? `/${tab}` : ''}${selectedId ? ` ws:${selectedId}` : ''}`
  } catch {
    return 'unknown'
  }
}

/** Send one crash to the main process, which logs it and decides whether to report it. */
export function report(kind: CrashKind, thrown: unknown, componentStack?: string | null): void {
  try {
    const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
    const now = Date.now()
    // A loop throws the same error many times a second; one report per message per 10s is plenty.
    for (const [k, t] of sent) if (t < now - 60_000) sent.delete(k)
    if ((sent.get(message) ?? 0) > now - REPEAT_MS) return
    sent.set(message, now)
    const components = (componentStack ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 12)
      .join(' < ')
    void window.sinfonie.invoke('telemetry:rendererCrash', {
      kind,
      message,
      stack: thrown instanceof Error ? (thrown.stack ?? '').split('\n').slice(0, 14).join('\n') : undefined,
      componentStack: components || undefined,
      screen: screen(),
      trail: trail.map((t) => (t.n > 1 ? `${t.step} x${t.n}` : t.step))
    })
  } catch {
    /* never throw from the reporter */
  }
}

/** Catch what escapes React: errors thrown from IPC callbacks and promises, where #185 lands. */
export function installCrashReporting(): void {
  window.addEventListener('error', (e) => report('uncaught', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => report('rejection', e.reason))
}
