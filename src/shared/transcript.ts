import type { AgentEvent, ChatItem, ChatToolBlock } from './types'

/**
 * Pure reducer turning agent events into a transcript. Used by the main
 * process to persist conversations and by the renderer to render them, so
 * both sides always agree on what a conversation looks like.
 */
export function applyEvent(items: ChatItem[], e: AgentEvent): ChatItem[] {
  switch (e.type) {
    case 'user_message':
      return [...items, { id: e.itemId, role: 'user', blocks: [...(e.images ?? []).map((image) => ({ type: 'image' as const, image })), { type: 'text' as const, text: e.text }], createdAt: e.createdAt }]
    case 'notice':
      return [...items, { id: e.itemId, role: 'system', level: e.level, blocks: [{ type: 'text', text: e.text }], createdAt: e.createdAt }]
    case 'assistant_start':
      return [...items, { id: e.itemId, role: 'assistant', blocks: [], createdAt: new Date().toISOString() }]
    case 'text_delta':
    case 'thinking_delta': {
      // Models that omit reasoning stream empty thinking deltas; nothing to show for those.
      if (e.type === 'thinking_delta' && !e.text) return items
      const kind = e.type === 'text_delta' ? 'text' : 'thinking'
      return updateItem(items, e.itemId, (it) => {
        const last = it.blocks[it.blocks.length - 1]
        if (last && last.type === kind) return { ...it, blocks: [...it.blocks.slice(0, -1), { type: kind, text: last.text + e.text }] }
        return { ...it, blocks: [...it.blocks, { type: kind, text: e.text }] }
      })
    }
    case 'tool_start':
      return updateItem(items, e.itemId, (it) => ({
        ...it,
        blocks: [...it.blocks, { type: 'tool', toolUseId: e.toolUseId, name: e.name, input: undefined, done: false } as ChatToolBlock]
      }))
    case 'tool_input':
      return updateItem(items, e.itemId, (it) => ({
        ...it,
        blocks: it.blocks.map((b) => (b.type === 'tool' && b.toolUseId === e.toolUseId ? { ...b, input: e.input } : b))
      }))
    case 'subagent':
      return items.map((it) =>
        it.role !== 'assistant'
          ? it
          : {
              ...it,
              blocks: it.blocks.map((b) =>
                b.type === 'tool' && b.toolUseId === e.parentToolUseId
                  ? {
                      ...b,
                      sub: {
                        model: e.model ?? b.sub?.model,
                        toolCalls: (b.sub?.toolCalls ?? 0) + e.tools.length,
                        lastTool: e.tools[e.tools.length - 1] ?? b.sub?.lastTool,
                        text: e.text ?? b.sub?.text,
                        steps: [...(b.sub?.steps ?? []), ...e.steps].slice(-300)
                      }
                    }
                  : b
              )
            }
      )
    case 'tool_result':
      return items.map((it) =>
        it.role !== 'assistant'
          ? it
          : { ...it, blocks: it.blocks.map((b) => (b.type === 'tool' && b.toolUseId === e.toolUseId ? { ...b, result: e.result, isError: e.isError, done: true } : b)) }
      )
    default:
      return items
  }
}

function updateItem(items: ChatItem[], itemId: string, fn: (it: ChatItem) => ChatItem): ChatItem[] {
  return items.map((it) => (it.id === itemId ? fn(it) : it))
}
