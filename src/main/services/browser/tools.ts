/**
 * The agent's browser tools, defined once and exposed both as an in-process MCP server (Claude
 * Code) and as AI SDK tools (native engine). Acting tools on sensitive origins ask the user first.
 */
import { z } from 'zod'
import { createSdkMcpServer, tool as sdkTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import { tool as aiTool, type ToolSet } from 'ai'
import * as browser from './service'
import type { BrowserTab, Shot } from './driver'
import { askPermission } from '../interaction'
import { getStore } from '../../store'
import { getWorkspace } from '../workspaces'
import { isAbsolute, relative, resolve } from 'path'

interface Out {
  text: string
  image?: Shot
}
export interface Def {
  name: string
  kind: 'read' | 'act'
  description: string
  shape: z.ZodRawShape
  run: (workspaceId: string, input: Record<string, unknown>) => Promise<Out>
}

/** Consoles where a click can change production: every acting tool asks the user, whatever the mode. */
export const DEFAULT_SENSITIVE_ORIGINS = ['console.aws.amazon.com', 'dash.cloudflare.com', 'console.cloud.google.com', 'portal.azure.com', 'vercel.com', 'app.netlify.com', 'github.com/settings', 'github.com/organizations', 'dashboard.stripe.com', 'app.datadoghog.com', 'app.datadoghq.com', 'fly.io', 'railway.app', 'dashboard.render.com', 'supabase.com/dashboard', 'cloud.digitalocean.com', 'dashboard.heroku.com', 'console.hetzner.cloud', 'cloud.mongodb.com', 'console.upstash.com', 'app.planetscale.com', 'console.neon.tech', 'admin.google.com', 'id.atlassian.com', 'admin.atlassian.com', 'app.1password.com', 'accounts.google.com']

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const allowedOrigins = new Map<string, Set<string>>() // workspaceId -> hostnames allowed for this session

function isSensitive(url: string, workspaceId: string): boolean {
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname
    path = u.pathname
  } catch {
    return false
  }
  if (allowedOrigins.get(workspaceId)?.has(host)) return false
  const extra = (() => {
    try {
      const ws = getWorkspace(workspaceId)
      return getStore().get().spaces.find((s) => s.id === ws.spaceId)?.browserSensitiveOrigins ?? []
    } catch {
      return []
    }
  })()
  return [...DEFAULT_SENSITIVE_ORIGINS, ...extra].some((pat) => {
    const [h, ...rest] = pat.split('/')
    const p = rest.length ? '/' + rest.join('/') : ''
    return (host === h || host.endsWith('.' + h)) && path.startsWith(p)
  })
}

async function guard(workspaceId: string, name: string, input: Record<string, unknown>, tab: BrowserTab): Promise<void> {
  const url = tab.url()
  if (!isSensitive(url, workspaceId)) return
  const d = await askPermission({ workspaceId, toolName: name, input: { ...input, url, reason: 'This site is on the sensitive-origins list: actions here can change production.' }, canAlwaysAllow: true })
  if (d.decision === 'deny') throw new Error(`The user declined ${name} on ${new URL(url).hostname}${d.message ? `: ${d.message}` : ''}. Ask them to do this step, or take another route.`)
  if (d.decision === 'always') {
    let set = allowedOrigins.get(workspaceId)
    if (!set) allowedOrigins.set(workspaceId, (set = new Set()))
    set.add(new URL(url).hostname)
  }
}

const after = async (tab: BrowserTab, did: string): Promise<Out> => ({ text: `${did}\n\n${await tab.snapshot(12_000)}` })
const tabIdArg = { tab_id: z.string().optional().describe('Which tab; default the active one') }

const DEFS: Def[] = [
  {
    name: 'browser_navigate',
    kind: 'read',
    description: 'Open a URL in the workspace browser (the active tab, or tab_id). Bare hosts get https://, localhost gets http://. Returns a compact accessibility snapshot of the loaded page with refs you can click or type into.',
    shape: { url: z.string(), ...tabIdArg },
    run: (ws, i) => browser.agentOp(ws, async (tab) => (await tab.navigate(String(i.url)), after(tab, `Loaded ${tab.title()} ${tab.url()}`)), i.tab_id as string | undefined)
  },
  {
    name: 'browser_snapshot',
    kind: 'read',
    description: 'Accessibility snapshot of the current page: roles, names, values and [ref=eN] handles for interactive elements. Cheaper and more reliable than a screenshot for deciding what to click or type. Refs are only valid until the page changes.',
    shape: { max_chars: z.number().int().min(2000).max(80_000).optional(), ...tabIdArg },
    run: (ws, i) => browser.agentOp(ws, async (tab) => ({ text: await tab.snapshot((i.max_chars as number | undefined) ?? 30_000) }), i.tab_id as string | undefined)
  },
  {
    name: 'browser_screenshot',
    kind: 'read',
    description: 'JPEG screenshot of the visible viewport, so you can see layout, images and visual bugs. Only works while the workspace Browser tab is on screen; use browser_snapshot for structure.',
    shape: { ...tabIdArg },
    run: (ws, i) => browser.agentOp(ws, async (tab) => ({ text: `Screenshot of ${tab.title()} ${tab.url()}`, image: await tab.screenshot() }), i.tab_id as string | undefined)
  },
  {
    name: 'browser_click',
    kind: 'act',
    description: 'Click an element by its ref from the latest snapshot. Returns a fresh snapshot after the page settles.',
    shape: { ref: z.string().describe('e.g. "e12"'), double: z.boolean().optional(), button: z.enum(['left', 'right', 'middle']).optional(), ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          await guard(ws, 'browser_click', i, tab)
          await tab.click(String(i.ref), { double: Boolean(i.double), button: i.button as 'left' | undefined })
          return after(tab, `Clicked ${i.ref}.`)
        },
        i.tab_id as string | undefined
      )
  },
  {
    name: 'browser_type',
    kind: 'act',
    description: 'Type into a field by ref. Replaces the current content unless replace=false. submit=true presses Enter afterwards.',
    shape: { ref: z.string(), text: z.string(), submit: z.boolean().optional(), replace: z.boolean().optional(), ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          await guard(ws, 'browser_type', { ...i, text: /password/i.test(String(i.ref)) ? '•••' : i.text }, tab)
          await tab.type(String(i.ref), String(i.text), { submit: Boolean(i.submit), replace: i.replace !== false })
          return after(tab, `Typed into ${i.ref}${i.submit ? ' and pressed Enter' : ''}.`)
        },
        i.tab_id as string | undefined
      )
  },
  {
    name: 'browser_press_key',
    kind: 'act',
    description: 'Press a key or combination on the focused element: "Enter", "Escape", "Tab", "ArrowDown", "Meta+a", "Shift+Tab", a single character.',
    shape: { key: z.string(), ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          await guard(ws, 'browser_press_key', i, tab)
          await tab.press(String(i.key))
          return after(tab, `Pressed ${i.key}.`)
        },
        i.tab_id as string | undefined
      )
  },
  {
    name: 'browser_scroll',
    kind: 'read',
    description: 'Scroll the page (or the element at ref) up or down by amount pixels (default 600). Returns a fresh snapshot.',
    shape: { direction: z.enum(['up', 'down']), amount: z.number().int().min(50).max(10_000).optional(), ref: z.string().optional(), ...tabIdArg },
    run: (ws, i) => browser.agentOp(ws, async (tab) => (await tab.scroll(i.direction as 'up' | 'down', (i.amount as number | undefined) ?? 600, i.ref as string | undefined), after(tab, `Scrolled ${i.direction}.`)), i.tab_id as string | undefined)
  },
  {
    name: 'browser_select',
    kind: 'act',
    description: 'Choose option(s) in a <select> by ref, matching option value or visible text.',
    shape: { ref: z.string(), values: z.array(z.string()).min(1), ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          await guard(ws, 'browser_select', i, tab)
          const r = await tab.select(String(i.ref), i.values as string[])
          return after(tab, `Select ${i.ref}: ${r}.`)
        },
        i.tab_id as string | undefined
      )
  },
  {
    name: 'browser_get_text',
    kind: 'read',
    description: 'The visible text of the page (innerText), for reading articles, docs, logs or tables in full.',
    shape: { max_chars: z.number().int().min(1000).max(200_000).optional(), ...tabIdArg },
    run: (ws, i) => browser.agentOp(ws, async (tab) => ({ text: await tab.text((i.max_chars as number | undefined) ?? 40_000) }), i.tab_id as string | undefined)
  },
  {
    name: 'browser_wait',
    kind: 'read',
    description: 'Wait until text appears, a CSS selector exists, the URL contains a string, or the network goes idle. Default timeout 10 s, max 60 s.',
    shape: { text: z.string().optional(), selector: z.string().optional(), url_contains: z.string().optional(), network_idle: z.boolean().optional(), timeout_ms: z.number().int().optional(), ...tabIdArg },
    run: (ws, i) => browser.agentOp(ws, async (tab) => ({ text: await tab.waitFor({ text: i.text as string | undefined, selector: i.selector as string | undefined, urlContains: i.url_contains as string | undefined, networkIdle: i.network_idle !== false && !i.text && !i.selector && !i.url_contains ? true : Boolean(i.network_idle), timeoutMs: i.timeout_ms as number | undefined }) }), i.tab_id as string | undefined)
  },
  {
    name: 'browser_console',
    kind: 'read',
    description: 'Recent console messages of the tab (errors, warnings, logs), newest last. clear=true empties the buffer after reading.',
    shape: { level: z.enum(['error', 'warning', 'info', 'all']).optional(), clear: z.boolean().optional(), ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          const lvl = (i.level as string | undefined) ?? 'all'
          const rows = tab.console.filter((c) => lvl === 'all' || c.level === lvl || (lvl === 'warning' && c.level === 'error'))
          const text = rows.length ? rows.slice(-150).map((c) => `[${c.at.slice(11, 19)}] ${c.level}: ${c.text}`).join('\n') : '(no console messages)'
          if (i.clear) tab.console.length = 0
          return { text }
        },
        i.tab_id as string | undefined
      )
  },
  {
    name: 'browser_network',
    kind: 'read',
    description: 'Recent network requests of the tab: id, method, status, type, URL, with an optional substring filter on the URL. Failed requests are marked. Pass body_of=<id> to get that response body (JSON APIs, error pages).',
    shape: { filter: z.string().optional(), body_of: z.string().optional(), ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          if (i.body_of) return { text: await tab.responseBody(String(i.body_of)) }
          const f = (i.filter as string | undefined) ?? ''
          const rows = tab.network.filter((n) => !f || n.url.includes(f)).slice(-150)
          return { text: rows.length ? rows.map((n) => `${n.id}  ${n.method} ${n.status ?? (n.failed ? `FAILED ${n.failed}` : '…')} ${n.type ?? ''} ${n.url}`).join('\n') : '(no requests recorded)' }
        },
        i.tab_id as string | undefined
      )
  },
  {
    name: 'browser_upload',
    kind: 'act',
    description: 'Attach workspace files to a file input (ref of the input or its button). Paths must be inside the workspace worktrees.',
    shape: { ref: z.string(), paths: z.array(z.string()).min(1), ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          const roots = getWorkspace(ws).repos.map((r) => r.worktreePath)
          const files = (i.paths as string[]).map((p) => {
            const abs = isAbsolute(p) ? p : resolve(roots[0] ?? '/', p)
            if (!roots.some((r) => !relative(r, abs).startsWith('..') && !isAbsolute(relative(r, abs)))) throw new Error(`${p} is outside the workspace.`)
            return abs
          })
          await guard(ws, 'browser_upload', { ...i, paths: files }, tab)
          await tab.upload(String(i.ref), files)
          return after(tab, `Attached ${files.length} file${files.length === 1 ? '' : 's'} to ${i.ref}.`)
        },
        i.tab_id as string | undefined
      )
  },
  {
    name: 'browser_downloads',
    kind: 'read',
    description: 'Files downloaded through the workspace browser. They are saved under <workspace>/.sinfonie/downloads and can be read with the file tools.',
    shape: {},
    run: async (ws) => {
      const d = browser.snapshot(ws).downloads
      return { text: d.length ? d.map((x) => `${x.state.padEnd(11)} ${x.size} bytes  ${x.path}`).join('\n') : '(no downloads yet)' }
    }
  },
  {
    name: 'browser_tabs',
    kind: 'read',
    description: 'List, open, select or close tabs of the workspace browser.',
    shape: { action: z.enum(['list', 'new', 'select', 'close']).default('list'), url: z.string().optional(), tab_id: z.string().optional() },
    run: async (ws, i) => {
      const act = (i.action as string | undefined) ?? 'list'
      if (act === 'new') {
        const t = browser.newTab(ws)
        if (i.url) await browser.agentOp(ws, (tab) => tab.navigate(String(i.url)), t.id)
      } else if (act === 'select') browser.selectTab(ws, String(i.tab_id))
      else if (act === 'close') browser.closeTab(ws, String(i.tab_id))
      const s = browser.snapshot(ws)
      return { text: s.tabs.length ? s.tabs.map((t) => `${t.id === s.activeId ? '*' : ' '} ${t.id}  ${t.title}  ${t.url}`).join('\n') : '(no tabs; browser_navigate opens one)' }
    }
  },
  {
    name: 'browser_back',
    kind: 'read',
    description: 'Go back in the tab history.',
    shape: { ...tabIdArg },
    run: (ws, i) =>
      browser.agentOp(
        ws,
        async (tab) => {
          if (tab.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack()
          await tab.settle(2000)
          return after(tab, 'Went back.')
        },
        i.tab_id as string | undefined
      )
  }
]

const EVALUATE: Def = {
  name: 'browser_evaluate',
  kind: 'act',
  description: 'Run a JavaScript expression in the page and return its result. Use sparingly; prefer the other tools.',
  shape: { expression: z.string(), ...tabIdArg },
  run: (ws, i) =>
    browser.agentOp(
      ws,
      async (tab) => {
        await guard(ws, 'browser_evaluate', i, tab)
        return { text: await tab.evaluate(String(i.expression)) }
      },
      i.tab_id as string | undefined
    )
}

export function toolDefs(): Def[] {
  return getStore().get().settings.browserEvaluate ? [...DEFS, EVALUATE] : DEFS
}
const defs = toolDefs

/** Run one tool and shape the result the MCP way (text plus an optional image), never throwing. */
export async function runForMcp(workspaceId: string, d: Def, args: Record<string, unknown>): Promise<{ content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }> {
  try {
    const out = await d.run(workspaceId, args)
    return { content: [{ type: 'text', text: out.text }, ...(out.image ? [{ type: 'image' as const, data: out.image.data, mimeType: out.image.mimeType }] : [])] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${errText(err)}` }], isError: true }
  }
}

export const READ_TOOLS = DEFS.filter((d) => d.kind === 'read').map((d) => d.name)
/** Claude Code names for the read-only tools, so they never prompt in Default mode. */
export function sdkAllowedTools(): string[] {
  return READ_TOOLS.map((n) => `mcp__browser__${n}`)
}
export function isBrowserTool(name: string): boolean {
  return name.startsWith('browser_') || name.startsWith('mcp__browser__')
}
export function isBrowserReadTool(name: string): boolean {
  return READ_TOOLS.includes(name.replace(/^mcp__browser__/, ''))
}

export function promptFor(port: number): string {
  return `You have a browser inside Sinfonie (tools browser_*). Use it to check the running app at http://localhost:${port} (this workspace owns ports ${port}-${port + 9}), read documentation, or operate web consoles the user is logged into. Take browser_snapshot before acting; click and type by the [ref=eN] handles it returns, and take a new snapshot after the page changes. Actions on infrastructure consoles ask the user first; never enter credentials yourself, ask the user to sign in.`
}

export function sdkServer(workspaceId: string): NonNullable<Options['mcpServers']>[string] {
  return createSdkMcpServer({
    name: 'browser',
    tools: defs().map((d) => sdkTool(d.name, d.description, d.shape, (args) => runForMcp(workspaceId, d, args as Record<string, unknown>)))
  })
}

export function aiTools(workspaceId: string): ToolSet {
  return Object.fromEntries(
    defs().map((d) => [
      d.name,
      aiTool<Record<string, unknown>, Out, Record<string, never>>({
        description: d.description,
        inputSchema: z.object(d.shape) as unknown as z.ZodType<Record<string, unknown>>,
        execute: async (input) => {
          try {
            return await d.run(workspaceId, input)
          } catch (err) {
            return { text: `Error: ${errText(err)}` }
          }
        },
        toModelOutput: ({ output: o }) => (o.image ? { type: 'content', value: [{ type: 'text', text: o.text }, { type: 'file', data: { type: 'data', data: o.image.data }, mediaType: o.image.mimeType }] } : { type: 'text', value: o.text })
      })
    ])
  )
}
