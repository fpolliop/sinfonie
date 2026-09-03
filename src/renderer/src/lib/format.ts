export function timeAgo(iso: string | undefined): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}
