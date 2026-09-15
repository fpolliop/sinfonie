import { z } from 'zod'
import { tool as aiTool, type ToolSet } from 'ai'
import { createSdkMcpServer, tool as sdkTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import * as slack from './slack'

/**
 * Slack for agents, on Sinfonie's own sign-in and the plain Web API: the same door the on-call
 * poller uses. Slack's MCP server refuses apps that are neither Marketplace-listed nor internal,
 * so the vendor app cannot use it; the Web API has no such rule. Search is the workhorse: one
 * call covers every channel, DM and thread the user can see. Channel history is throttled hard
 * for non-Marketplace apps (one call a minute, fifteen messages), so the tools say so.
 */

interface Match {
  text?: string
  user?: string
  username?: string
  ts: string
  channel?: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean }
  permalink?: string
}

const when = (ts: string): string => new Date(Number(ts.split('.')[0]) * 1000).toISOString().replace('T', ' ').slice(0, 16)

async function line(connId: string, m: { text?: string; user?: string; username?: string; ts: string; thread_ts?: string; reply_count?: number }, channel?: string): Promise<string> {
  const who = m.username ?? (await slack.userName(connId, m.user)) ?? m.user ?? 'unknown'
  const thread = m.thread_ts && m.thread_ts !== m.ts ? ` (in thread ${m.thread_ts})` : m.reply_count ? ` (${m.reply_count} replies)` : ''
  return `[${when(m.ts)}] ${who}${channel ? ` in ${channel}` : ''} · ts=${m.ts}${thread}\n${(m.text ?? '').trim()}`
}

async function search(connId: string, query: string, count: number, sort: 'timestamp' | 'score', page: number): Promise<string> {
  const r = await slack.api<{ messages: { total: number; matches: Match[]; paging?: { pages: number } } }>(connId, 'search.messages', { query, count: Math.min(100, Math.max(1, count)), sort, sort_dir: 'desc', page, highlight: false })
  const { matches, total, paging } = r.messages
  if (matches.length === 0) return `No messages match "${query}".`
  const lines: string[] = []
  for (const m of matches) {
    const ch = m.channel ? (m.channel.is_im ? 'a DM' : m.channel.is_mpim ? 'a group DM' : `#${m.channel.name ?? m.channel.id}`) : undefined
    lines.push(`${await line(connId, m, ch)}${m.channel ? `\nchannel=${m.channel.id}` : ''}${m.permalink ? `\n${m.permalink}` : ''}`)
  }
  return `${total} match${total === 1 ? '' : 'es'}${paging && paging.pages > 1 ? `, page ${page} of ${paging.pages}` : ''} for "${query}":\n\n${lines.join('\n\n')}`
}

async function historyText(connId: string, channel: string, oldest?: string): Promise<string> {
  const wait = slack.rateLimitWait('conversations.history')
  if (wait > 0) return `Slack allows one history call a minute for this app; try again in ${wait}s, or use slack_search instead.`
  const msgs = await slack.history(connId, channel, oldest)
  if (msgs.length === 0) return 'No messages in that window.'
  const out: string[] = []
  for (const m of msgs) out.push(await line(connId, m))
  return `${msgs.length} message${msgs.length === 1 ? '' : 's'} (newest ${slack.HISTORY_PAGE} at most per call; pass oldest=<last ts> to page):\n\n${out.join('\n\n')}`
}

async function threadText(connId: string, channel: string, ts: string): Promise<string> {
  const wait = slack.rateLimitWait('conversations.replies')
  if (wait > 0) return `Slack allows one thread call a minute for this app; try again in ${wait}s.`
  const msgs = await slack.replies(connId, channel, ts)
  if (msgs.length === 0) return 'No replies yet.'
  const out: string[] = []
  for (const m of msgs) out.push(await line(connId, m))
  return out.join('\n\n')
}

async function channelsText(connId: string, query?: string): Promise<string> {
  const list = await slack.listChannels(connId, query ?? '')
  if (list.length === 0) return 'No channels match.'
  return list
    .slice(0, 200)
    .map((c) => `#${c.name} · ${c.id}${c.is_member ? '' : ' (not a member)'}`)
    .join('\n')
}

/** What the system prompt says when Slack tools are attached. */
export function promptFor(connId: string): string {
  const c = slack.connection(connId)
  return [
    '',
    `Slack: connected as ${c.userName ?? 'the user'}${c.userId ? ` (user id ${c.userId})` : ''} in ${c.teamName ?? 'the workspace'}, through Sinfonie's own tools (mcp__slack).`,
    `Use slack_search first: it covers every channel, DM and thread at once. Slack search syntax works: "after:2026-09-12", "before:", "from:@name", "in:#channel", "is:thread", "has:link"${c.userId ? `, and "<@${c.userId}>" finds messages that mention the user` : ''}. Search for the user's mentions, then for DMs (in:@name of each person is not needed: search returns DMs too). Use slack_thread to read the context of a match and slack_permalink for links. slack_history is throttled to one call a minute, so reserve it for one specific channel.`,
    'Never post or react unless the task says so.'
  ].join('\n')
}

const searchShape = {
  query: z.string().describe('Slack search query, e.g. "<@U123> after:2026-09-12" or "from:@ana is:thread"'),
  count: z.number().int().min(1).max(100).optional().describe('Matches per page, default 40'),
  sort: z.enum(['timestamp', 'score']).optional().describe('Newest first (default) or best match'),
  page: z.number().int().min(1).optional()
}

/** Slack as an in-process MCP server for Claude workers and the Claude Code engine. */
export function sdkServer(connId: string): NonNullable<Options['mcpServers']>[string] {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  const guard = async (fn: () => Promise<string>) => {
    try {
      return text(await fn())
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Slack error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
  return createSdkMcpServer({
    name: 'slack',
    tools: [
      sdkTool('slack_search', 'Search messages across every channel, DM and thread the user can see. Supports Slack search modifiers (after:, before:, from:@, in:#, is:thread, has:link, "<@USERID>" for mentions).', searchShape, async ({ query, count, sort, page }) => guard(() => search(connId, query, count ?? 40, sort ?? 'timestamp', page ?? 1))),
      sdkTool('slack_channels', 'Channels the user can see, with ids. Optional name filter.', { query: z.string().optional() }, async ({ query }) => guard(() => channelsText(connId, query))),
      sdkTool('slack_history', 'Newest messages of one channel or DM (15 per call, one call a minute for this app). oldest = a ts to page back from.', { channel: z.string().describe('Channel id, e.g. C0123'), oldest: z.string().optional() }, async ({ channel, oldest }) => guard(() => historyText(connId, channel, oldest))),
      sdkTool('slack_thread', 'Replies of a thread, given the channel id and the parent message ts.', { channel: z.string(), ts: z.string() }, async ({ channel, ts }) => guard(() => threadText(connId, channel, ts))),
      sdkTool('slack_permalink', 'A link to one message.', { channel: z.string(), ts: z.string() }, async ({ channel, ts }) => guard(async () => (await slack.permalink(connId, channel, ts)) ?? 'No permalink available.')),
      sdkTool('slack_user', 'Display name of a user id.', { user: z.string() }, async ({ user }) => guard(async () => (await slack.userName(connId, user)) ?? user)),
      sdkTool('slack_post', 'Post a message as the user, optionally in a thread. Only when the task explicitly asks for it.', { channel: z.string(), text: z.string(), thread_ts: z.string().optional() }, async ({ channel, text: t, thread_ts }) => guard(async () => `Posted, ts=${await slack.post(connId, channel, t, thread_ts)}`))
    ]
  })
}

/** Slack as AI SDK tools for native workers. */
export function aiTools(connId: string): ToolSet {
  const guard = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn()
    } catch (err) {
      return `Slack error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return {
    slack_search: aiTool({ description: 'Search messages across every channel, DM and thread the user can see. Supports Slack search modifiers (after:, before:, from:@, in:#, is:thread, has:link, "<@USERID>" for mentions).', inputSchema: z.object(searchShape), execute: ({ query, count, sort, page }) => guard(() => search(connId, query, count ?? 40, sort ?? 'timestamp', page ?? 1)) }),
    slack_channels: aiTool({ description: 'Channels the user can see, with ids. Optional name filter.', inputSchema: z.object({ query: z.string().optional() }), execute: ({ query }) => guard(() => channelsText(connId, query)) }),
    slack_history: aiTool({ description: 'Newest messages of one channel or DM (15 per call, one call a minute for this app). oldest = a ts to page back from.', inputSchema: z.object({ channel: z.string(), oldest: z.string().optional() }), execute: ({ channel, oldest }) => guard(() => historyText(connId, channel, oldest)) }),
    slack_thread: aiTool({ description: 'Replies of a thread, given the channel id and the parent message ts.', inputSchema: z.object({ channel: z.string(), ts: z.string() }), execute: ({ channel, ts }) => guard(() => threadText(connId, channel, ts)) }),
    slack_permalink: aiTool({ description: 'A link to one message.', inputSchema: z.object({ channel: z.string(), ts: z.string() }), execute: ({ channel, ts }) => guard(async () => (await slack.permalink(connId, channel, ts)) ?? 'No permalink available.') }),
    slack_user: aiTool({ description: 'Display name of a user id.', inputSchema: z.object({ user: z.string() }), execute: ({ user }) => guard(async () => (await slack.userName(connId, user)) ?? user) }),
    slack_post: aiTool({ description: 'Post a message as the user, optionally in a thread. Only when the task explicitly asks for it.', inputSchema: z.object({ channel: z.string(), text: z.string(), thread_ts: z.string().optional() }), execute: ({ channel, text, thread_ts }) => guard(async () => `Posted, ts=${await slack.post(connId, channel, text, thread_ts)}`) })
  }
}
