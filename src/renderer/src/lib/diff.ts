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

/** One row of the side-by-side view: a hunk/meta line spanning both sides, or an old/new pair (either side may be empty padding). */
export interface SplitRow {
  kind: 'pair' | 'hunk' | 'meta'
  text?: string
  left?: DiffLine
  right?: DiffLine
}

/** Pairs removals with additions in order within each change block; the shorter side is padded with empty rows. */
export function toSplitRows(file: DiffFile): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ kind: 'pair', left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const l of file.lines) {
    if (l.kind === 'del') dels.push(l)
    else if (l.kind === 'add') adds.push(l)
    else {
      flush()
      if (l.kind === 'ctx') rows.push({ kind: 'pair', left: l, right: l })
      else rows.push({ kind: l.kind, text: l.text })
    }
  }
  flush()
  return rows
}

/** Where the changes sit in the new file: added/modified line numbers, and the new line numbers before which something was removed. */
export function changedNewLines(file: DiffFile): { added: Set<number>; deletedBefore: Set<number> } {
  const added = new Set<number>()
  const deletedBefore = new Set<number>()
  let nextNew = 1
  for (const l of file.lines) {
    if (l.kind === 'hunk') {
      const m = /\+(\d+)/.exec(l.text)
      if (m) nextNew = Number(m[1])
    } else if (l.kind === 'add' || l.kind === 'ctx') {
      const no = l.newNo ?? nextNew
      if (l.kind === 'add') added.add(no)
      nextNew = no + 1
    } else if (l.kind === 'del') {
      deletedBefore.add(nextNew)
    }
  }
  return { added, deletedBefore }
}
