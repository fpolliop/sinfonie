import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { C, mono } from './theme'
import type { ChatBlock, ChatItem, RemotePrompt } from './protocol'
import { answerPermission, answerQuestion } from './store'

export function Btn({ title, onPress, kind = 'default', style, disabled }: { title: string; onPress: () => void; kind?: 'default' | 'primary' | 'ok' | 'danger'; style?: ViewStyle; disabled?: boolean }): React.JSX.Element {
  const bg = kind === 'primary' ? C.accent2 : kind === 'ok' ? 'rgba(74,222,128,.15)' : kind === 'danger' ? 'rgba(248,113,113,.15)' : C.panel2
  const fg = kind === 'primary' ? '#fff' : kind === 'ok' ? C.ok : kind === 'danger' ? C.danger : C.text
  const border = kind === 'ok' ? 'rgba(74,222,128,.4)' : kind === 'danger' ? 'rgba(248,113,113,.4)' : kind === 'primary' ? 'transparent' : C.border
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }, style]}>
      <Text style={{ color: fg, fontWeight: '600', fontSize: 14 }}>{title}</Text>
    </Pressable>
  )
}
export function Badge({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'warn' | 'accent' | 'ok' }): React.JSX.Element {
  const color = tone === 'warn' ? C.warn : tone === 'accent' ? C.accent : tone === 'ok' ? C.ok : C.muted
  return (
    <View style={[s.badge, { borderColor: tone === 'muted' ? C.border : color + '73' }]}>
      <Text style={{ color, fontSize: 11 }}>{text}</Text>
    </View>
  )
}
export function Dot({ tone }: { tone: 'idle' | 'busy' | 'need' | 'on' }): React.JSX.Element {
  const color = tone === 'busy' ? C.accent : tone === 'need' ? C.warn : tone === 'on' ? C.ok : C.dim
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
}

const mdStyle = {
  body: { color: C.text, fontSize: 15, lineHeight: 22 },
  code_inline: { ...mono, backgroundColor: C.panel2, color: C.text, fontSize: 13, borderRadius: 4, paddingHorizontal: 4 },
  fence: { ...mono, backgroundColor: C.panel, borderColor: C.border, color: C.text, fontSize: 12.5, borderRadius: 8 },
  code_block: { ...mono, backgroundColor: C.panel, borderColor: C.border, color: C.text, fontSize: 12.5, borderRadius: 8 },
  link: { color: C.accent },
  heading1: { fontSize: 17, fontWeight: '700' as const, marginTop: 8 },
  heading2: { fontSize: 16, fontWeight: '700' as const, marginTop: 8 },
  heading3: { fontSize: 15, fontWeight: '700' as const, marginTop: 6 },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  blockquote: { backgroundColor: C.panel, borderLeftColor: C.border },
  table: { borderColor: C.border },
  tr: { borderColor: C.border },
  hr: { backgroundColor: C.border }
}

function headline(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  return String(i.command || i.description || i.file_path || i.path || i.pattern || i.query || i.url || i.prompt || Object.values(i)[0] || '').slice(0, 120)
}

function ToolBlock({ b }: { b: Extract<ChatBlock, { type: 'tool' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <View style={s.tool}>
      <Pressable onPress={() => setOpen((o) => !o)} style={s.toolHead}>
        <Text style={{ color: C.text, fontWeight: '600', fontSize: 13 }}>{b.name}</Text>
        <Text numberOfLines={1} style={[mono, { color: C.muted, fontSize: 12, flex: 1 }]}>
          {headline(b.input)}
        </Text>
        {!b.done && <Dot tone="busy" />}
        {b.isError && <Text style={{ color: C.danger, fontSize: 11 }}>error</Text>}
      </Pressable>
      {open && (
        <View style={{ borderTopWidth: 1, borderTopColor: C.border }}>
          {b.input !== undefined && <Text style={[mono, s.pre]}>{JSON.stringify(b.input, null, 2).slice(0, 3000)}</Text>}
          {b.result ? <Text style={[mono, s.pre, { color: b.isError ? C.danger : C.muted }]}>{String(b.result).slice(0, 4000)}</Text> : null}
        </View>
      )}
    </View>
  )
}

export function MessageItem({ item }: { item: ChatItem }): React.JSX.Element | null {
  if (item.role === 'user') {
    const text = item.blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
    return (
      <View style={s.user}>
        <Text style={{ color: C.text, fontSize: 15, lineHeight: 21 }}>{text}</Text>
      </View>
    )
  }
  if (item.role === 'system') {
    const text = item.blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
    if (!text.trim()) return null
    return (
      <Text style={{ color: item.level === 'error' ? C.danger : C.muted, fontSize: 12, textAlign: 'center', marginVertical: 4, paddingHorizontal: 20 }} numberOfLines={4}>
        {text}
      </Text>
    )
  }
  const parts = item.blocks.filter((b) => (b.type === 'text' ? b.text.trim() : b.type !== 'thinking' || b.text.trim()))
  if (!parts.length) return null
  return (
    <View style={{ marginVertical: 4 }}>
      {parts.map((b, i) => {
        if (b.type === 'text') return <Markdown key={i} style={mdStyle}>{b.text}</Markdown>
        if (b.type === 'thinking') return <Text key={i} style={{ color: C.dim, fontSize: 12, fontStyle: 'italic' }}>Thinking…</Text>
        if (b.type === 'image') return <Text key={i} style={{ color: C.muted, fontSize: 12 }}>[image: {b.image.name}]</Text>
        return <ToolBlock key={b.toolUseId} b={b} />
      })}
    </View>
  )
}

export function PromptCard({ prompt, workspaceName }: { prompt: RemotePrompt; workspaceName?: string }): React.JSX.Element {
  const [chosen, setChosen] = useState<number[]>([])
  const [free, setFree] = useState('')
  if (prompt.kind === 'permission') {
    const r = prompt.request
    const input = typeof r.input === 'object' ? JSON.stringify(r.input, null, 2) : String(r.input)
    return (
      <View style={s.card}>
        <View style={s.cardHead}>
          <Dot tone="need" />
          <Text style={s.cardTitle}>{r.toolName}</Text>
          {workspaceName ? <Badge text={workspaceName} /> : null}
        </View>
        <Text style={[mono, s.pre, { maxHeight: 160 }]} numberOfLines={8}>
          {input.slice(0, 2000)}
        </Text>
        <View style={s.row}>
          <Btn title="Allow" kind="ok" onPress={() => answerPermission(r.requestId, 'allow')} />
          {r.canAlwaysAllow && <Btn title="Always allow" onPress={() => answerPermission(r.requestId, 'always')} />}
          <Btn title="Deny" kind="danger" onPress={() => answerPermission(r.requestId, 'deny')} />
        </View>
      </View>
    )
  }
  const r = prompt.request
  const q = r.questions[0]
  const submit = (): void => {
    const answers: Record<string, string> = {}
    const labels = chosen.map((i) => q.options[i].label)
    if (labels.length) answers[q.question] = labels.join(', ')
    else if (free.trim()) answers[q.question] = free.trim()
    answerQuestion(r.requestId, answers, labels.length ? undefined : free.trim() || undefined)
  }
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Dot tone="need" />
        <Text style={s.cardTitle}>{q?.header || 'Question'}</Text>
        {workspaceName ? <Badge text={workspaceName} /> : null}
      </View>
      <Text style={{ color: C.text, fontSize: 14, marginBottom: 6 }}>{q?.question}</Text>
      {(q?.options ?? []).map((o, i) => {
        const sel = chosen.includes(i)
        return (
          <Pressable
            key={i}
            onPress={() => {
              if (!q.multiSelect) return answerQuestion(r.requestId, { [q.question]: o.label })
              setChosen((c) => (sel ? c.filter((x) => x !== i) : [...c, i]))
            }}
            style={[s.opt, sel && { borderColor: C.accent, backgroundColor: 'rgba(124,156,255,.15)' }]}
          >
            <Text style={{ color: C.text, fontWeight: '600', fontSize: 14 }}>{o.label}</Text>
            {o.description ? <Text style={{ color: C.muted, fontSize: 12 }}>{o.description}</Text> : null}
          </Pressable>
        )
      })}
      <View style={[s.row, { alignItems: 'center' }]}>
        <TextInput value={free} onChangeText={setFree} placeholder="Or answer in your own words" placeholderTextColor={C.dim} style={s.input} />
        <Btn title="Send" kind="primary" onPress={submit} disabled={!chosen.length && !free.trim()} />
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  btn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 },
  user: { alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: 'rgba(91,124,255,.22)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, borderBottomRightRadius: 4, marginVertical: 4 },
  tool: { borderWidth: 1, borderColor: C.border, borderRadius: 8, backgroundColor: C.panel, marginVertical: 4 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 7 },
  pre: { color: C.text, fontSize: 12, lineHeight: 17, padding: 8, backgroundColor: C.panel, borderRadius: 8 },
  card: { margin: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(251,191,36,.45)', backgroundColor: 'rgba(251,191,36,.06)', borderRadius: 12, gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { color: C.text, fontWeight: '700', fontSize: 14 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  opt: { borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2, borderRadius: 10, padding: 10, marginTop: 6 },
  input: { flex: 1, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel, color: C.text, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 }
})
