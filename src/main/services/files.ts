/**
 * Read-only file browsing for the workspace Files tab, confined to the workspace's worktrees
 * (and its own folder for repository-less workspaces).
 */
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { shell } from 'electron'
import { getWorkspace } from './workspaces'
import type { FsEntry } from '@shared/types'

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '.next', '.turbo', '.cache', 'dist', 'build', 'coverage', '.venv', '__pycache__', '.pnpm-store'])

function roots(workspaceId: string): string[] {
  const ws = getWorkspace(workspaceId)
  return [...ws.repos.map((r) => r.worktreePath), ws.rootPath]
}
function confine(workspaceId: string, p: string): string {
  const abs = resolve(p)
  const ok = roots(workspaceId).some((r) => {
    const rel = relative(r, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
  if (!ok) throw new Error(`${p} is outside the workspace`)
  return abs
}

export function list(workspaceId: string, dir: string, showHidden = false): FsEntry[] {
  const abs = confine(workspaceId, dir)
  const out: FsEntry[] = []
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (!showHidden && (HIDDEN.has(e.name) || e.name.startsWith('.'))) continue
    const path = join(abs, e.name)
    let size = 0
    try {
      size = e.isFile() ? statSync(path).size : 0
    } catch {
      /* unreadable */
    }
    out.push({ name: e.name, path, dir: e.isDirectory(), size })
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

const MAX = 512 * 1024
export function read(workspaceId: string, path: string): { text: string; truncated: boolean; binary: boolean; size: number } {
  const abs = confine(workspaceId, path)
  const size = statSync(abs).size
  const fd = openSync(abs, 'r')
  try {
    const head = Buffer.alloc(Math.min(8000, size))
    readSync(fd, head, 0, head.length, 0)
    if (head.includes(0)) return { text: '', truncated: false, binary: true, size }
  } finally {
    closeSync(fd)
  }
  const buf = readFileSync(abs)
  const slice = buf.subarray(0, MAX)
  return { text: slice.toString('utf8'), truncated: buf.length > MAX, binary: false, size }
}

export function reveal(workspaceId: string, path: string): void {
  shell.showItemInFolder(confine(workspaceId, path))
}
export async function open(workspaceId: string, path: string): Promise<void> {
  const err = await shell.openPath(confine(workspaceId, path))
  if (err) throw new Error(err)
}
