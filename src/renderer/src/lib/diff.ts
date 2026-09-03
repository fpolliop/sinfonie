export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  text: string
  oldNo?: number
  newNo?: number
}
export interface DiffFile {
  path: string
  lines: DiffLine[]
  adds: number
  dels: number
}

/** Minimal unified-diff parser: enough for a readable per-file view. */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = /b\/(.+)$/.exec(line)
      cur = { path: m ? m[1] : line, lines: [], adds: 0, dels: 0 }
      files.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldNo = m ? Number(m[1]) : 0
      newNo = m ? Number(m[2]) : 0
      cur.lines.push({ kind: 'hunk', text: line })
    } else if (/^(\+\+\+|---|index |new file|deleted file|similarity|rename|Binary|\\)/.test(line)) {
      cur.lines.push({ kind: 'meta', text: line })
    } else if (line.startsWith('+')) {
      cur.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
      cur.adds++
    } else if (line.startsWith('-')) {
      cur.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
      cur.dels++
    } else {
      cur.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}
