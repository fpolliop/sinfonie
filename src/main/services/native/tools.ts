import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { spawn } from 'child_process'
import * as resources from '../resources'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import fg from 'fast-glob'
import type { Question, Workspace } from '@shared/types'
import { askQuestion } from '../interaction'

/**
 * The native engine's built-in tools. Same names as Claude Code's where the
 * shape matches (Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion), so the
 * chat renders them identically. Every path is confined to the workspace.
 */
export interface ToolContext {
  workspace: Workspace
  roots: string[]
  cwd: string
  signal?: AbortSignal
}

function within(roots: string[], p: string): boolean {
  const abs = resolve(p)
  return roots.some((r) => !relative(r, abs).startsWith('..') && !isAbsolute(relative(r, abs)))
}

function resolvePath(ctx: ToolContext, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p)
  if (!within(ctx.roots, abs)) throw new Error(`Path ${abs} is outside the workspace (${ctx.roots.join(', ')}).`)
  return abs
}

const MAX_OUT = 60_000

export function buildTools(ctx: ToolContext): ToolSet {
  const Read = tool({
    description: 'Read a file from the workspace. Returns numbered lines. Use offset/limit for large files.',
    inputSchema: z.object({ file_path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(2000).optional() }),
    execute: async ({ file_path, offset, limit }) => {
      const abs = resolvePath(ctx, file_path)
      if (!existsSync(abs)) return `File not found: ${abs}`
      const st = statSync(abs)
      if (st.isDirectory()) return `Is a directory: ${abs}. Use LS.`
      if (st.size > 5_000_000) return `File is ${st.size} bytes; too large to read whole. Use offset/limit or Grep.`
      const lines = readFileSync(abs, 'utf8').split('\n')
      const start = (offset ?? 1) - 1
      const slice = lines.slice(start, start + (limit ?? 2000))
      const body = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n')
      return body.length > MAX_OUT ? body.slice(0, MAX_OUT) + `\n… truncated; ${lines.length} lines total` : body + (lines.length > start + slice.length ? `\n… ${lines.length - start - slice.length} more lines` : '')
    }
  })
  const Write = tool({
    description: 'Create or overwrite a file in the workspace with the given content.',
    inputSchema: z.object({ file_path: z.string(), content: z.string() }),
    execute: async ({ file_path, content }) => {
      const abs = resolvePath(ctx, file_path)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
      return `Wrote ${content.length} characters to ${abs}`
    }
  })
  const Edit = tool({
    description: 'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.',
    inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
    execute: async ({ file_path, old_string, new_string, replace_all }) => {
      const abs = resolvePath(ctx, file_path)
      if (!existsSync(abs)) return `File not found: ${abs}`
      const src = readFileSync(abs, 'utf8')
      const count = src.split(old_string).length - 1
      if (count === 0) return `old_string not found in ${abs}. Read the file and copy the exact text, including whitespace.`
      if (count > 1 && !replace_all) return `old_string appears ${count} times in ${abs}; include more context to make it unique, or set replace_all.`
      writeFileSync(abs, replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string))
      return `Edited ${abs} (${replace_all ? count : 1} replacement${count === 1 || !replace_all ? '' : 's'})`
    }
  })
  const LS = tool({
    description: 'List a directory in the workspace.',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async ({ path }) => {
      const abs = resolvePath(ctx, path ?? ctx.cwd)
      if (!existsSync(abs)) return `Not found: ${abs}`
      return readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort()
        .join('\n')
    }
  })
  const Glob = tool({
    description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Returns paths relative to the searched directory.',
    inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
    execute: async ({ pattern, path }) => {
      const cwd = resolvePath(ctx, path ?? ctx.cwd)
      const files = await fg(pattern, { cwd, ignore: ['**/node_modules/**', '**/.git/**'], dot: false, onlyFiles: true, suppressErrors: true })
      return files.length ? files.slice(0, 500).join('\n') + (files.length > 500 ? `\n… ${files.length - 500} more` : '') : 'No files matched.'
    }
  })
  const Grep = tool({
    description: 'Search file contents with a regular expression (ripgrep when available). Returns file:line:text.',
    inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), glob: z.string().optional().describe('Limit to files matching this glob, e.g. "*.ts"'), max_results: z.number().int().optional() }),
    execute: async ({ pattern, path, glob, max_results }) => {
      const cwd = resolvePath(ctx, path ?? ctx.cwd)
      const useRg = await which('rg')
      const args = useRg ? ['-n', '--no-heading', '--color=never', '-m', String(max_results ?? 200), ...(glob ? ['-g', glob] : []), '-e', pattern, '.'] : ['-rn', '-E', ...(glob ? ['--include', glob] : []), '-e', pattern, '.']
      const out = await run(useRg ? 'rg' : 'grep', args, cwd, ctx.signal, 30_000)
      const text = out.stdout.trim()
      return text ? text.slice(0, MAX_OUT) : 'No matches.'
    }
  })
  const Bash = tool({
    description: 'Run a shell command in the workspace (zsh, login shell). Use for git, package managers, tests. Output is capped.',
    inputSchema: z.object({ command: z.string(), description: z.string().optional().describe('What this command does, in a few words'), timeout: z.number().int().optional().describe('Milliseconds, default 120000, max 600000'), cwd: z.string().optional() }),
    execute: async ({ command, timeout, cwd }) => {
      const dir = cwd ? resolvePath(ctx, cwd) : ctx.cwd
      const out = await run('/bin/zsh', ['-lc', command], dir, ctx.signal, Math.min(timeout ?? 120_000, 600_000))
      const text = [out.stdout, out.stderr].filter(Boolean).join('\n').trim()
      const body = text.length > MAX_OUT ? text.slice(0, MAX_OUT / 2) + '\n… truncated …\n' + text.slice(-MAX_OUT / 2) : text
      return `${body}${body ? '\n' : ''}[exit ${out.code}${out.timedOut ? ', timed out' : ''}]`
    }
  })
  const AskUserQuestion = tool({
    description: 'Ask the user one to four multiple-choice questions when a decision is theirs to make. Blocks until they answer.',
    inputSchema: z.object({
      questions: z.array(z.object({ question: z.string(), header: z.string().max(12), multiSelect: z.boolean().default(false), options: z.array(z.object({ label: z.string(), description: z.string().default('') })).min(2).max(4) })).min(1).max(4)
    }),
    execute: async ({ questions }) => {
      const r = await askQuestion(ctx.workspace.id, questions as Question[], ctx.signal)
      if (r.cancelled) return 'The user dismissed the questions without answering. Continue with your best judgement.'
      if (r.response) return `The user responded: ${r.response}`
      return Object.entries(r.answers).map(([q, a]) => `${q}\n→ ${a}`).join('\n\n')
    }
  })
  return { Read, Write, Edit, LS, Glob, Grep, Bash, AskUserQuestion }
}


let rgKnown: boolean | null = null
async function which(bin: string): Promise<boolean> {
  if (bin === 'rg' && rgKnown !== null) return rgKnown
  const r = await run('/bin/zsh', ['-lc', `command -v ${bin}`], process.cwd(), undefined, 5000)
  const ok = r.code === 0
  if (bin === 'rg') rgKnown = ok
  return ok
}

export function run(cmd: string, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env })
    resources.registerProcess(child.pid, { kind: 'tool', cwd, label: cmd })
    child.once('exit', () => resources.unregisterProcess(child.pid))
    let stdout = '',
      stderr = '',
      timedOut = false
    const t = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    signal?.addEventListener('abort', () => child.kill('SIGKILL'))
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ stdout, stderr, code, timedOut })
    })
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ stdout, stderr: String(e), code: -1, timedOut })
    })
  })
}
