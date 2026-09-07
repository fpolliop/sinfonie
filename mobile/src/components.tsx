/** Conversation pieces: messages, tool calls, prompt cards, the typing indicator. */
import React, { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Markdown from 'react-native-markdown-display'
import * as Haptics from 'expo-haptics'
import { C, R, S, T, mono } from './theme'
import { Badge, Button, Dot, Icon } from './ui'
import type { ChatBlock, ChatItem, RemotePrompt } from './protocol'
import { answerPermission, answerQuestion } from './store'
import { relativeTime } from './util'

const mdStyle = {
  body: { color: C.text, fontSize: 15, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  code_inline: { ...mono, backgroundColor: C.panel2, color: C.text, fontSize: 13, borderRadius: 4, paddingHorizontal: 4 },
  fence: { ...mono, backgroundColor: C.panel, borderColor: C.border, color: C.text, fontSize: 12.5, borderRadius: R.sm, padding: 10 },
  code_block: { ...mono, backgroundColor: C.panel, borderColor: C.border, color: C.text, fontSize: 12.5, borderRadius: R.sm, padding: 10 },
  link: { color: C.accent },
  heading1: { fontSize: 18, fontWeight: '700' as const, marginTop: 10, marginBottom: 4 },
  heading2: { fontSize: 16, fontWeight: '700' as const, marginTop: 10, marginBottom: 4 },
  heading3: { fontSize: 15, fontWeight: '700' as const, marginTop: 8, marginBottom: 2 },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  bullet_list_icon: { color: C.muted },
  ordered_list_icon: { color: C.muted },
  blockquote: { backgroundColor: C.panel, borderLeftColor: C.accent, borderLeftWidth: 3, paddingLeft: 10 },
  table: { borderColor: C.border, borderRadius: R.sm },
  tr: { borderColor: C.border },
  th: { padding: 6 },
  td: { padding: 6 },
  hr: { backgroundColor: C.border, marginVertical: 10 }
}

function headline(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  return String(i.command || i.description || i.file_path || i.path || i.pattern || i.query || i.url || i.prompt || Object.values(i)[0] || '').slice(0, 140)
}
const toolIcon = (name: string): React.ComponentProps<typeof Icon>['name'] => {
  const n = name.toLowerCase()
  if (n.includes('bash') || n.includes('shell')) return 'terminal-outline'
  if (n.includes('read') || n.includes('glob') || n.includes('grep') || n.includes('search')) return 'search-outline'
  if (n.includes('write') || n.includes('edit')) return 'create-outline'
  if (n.includes('web') || n.includes('fetch') || n.includes('browser')) return 'globe-outline'
  if (n.includes('agent') || n.includes('task')) return 'people-outline'
  return 'construct-outline'
}

function ToolBlock({ b }: { b: Extract<ChatBlock, { type: 'tool' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <View style={s.tool}>
      <Pressable onPress={() => setOpen((o) => !o)} style={s.toolHead}>
        <Icon name={toolIcon(b.name)} size={14} color={b.isError ? C.danger : C.muted} />
        <Text style={{ color: C.text, fontWeight: '600', fontSize: 13 }}>{b.name}</Text>
        <Text numberOfLines={1} style={[mono, { color: C.muted, fontSize: 12, flex: 1 }]}>
          {headline(b.input)}
        </Text>
        {!b.done ? <Dot tone="busy" size={7} /> : b.isError ? <Text style={{ color: C.danger, fontSize: 11, fontWeight: '600' }}>failed</Text> : <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} color={C.dim} />}
      </Pressable>
      {open && (
        <View style={{ borderTopWidth: 1, borderTopColor: C.border }}>
          {b.input !== undefined && <Text style={[mono, s.pre]}>{JSON.stringify(b.input, null, 2).slice(0, 3000)}</Text>}
          {b.result ? <Text style={[mono, s.pre, { color: b.isError ? C.danger : C.muted, borderTopWidth: 1, borderTopColor: C.border }]}>{String(b.result).slice(0, 4000)}</Text> : null}
        </View>
      )}
    </View>
  )
}

const textOf = (item: ChatItem): string =>
  item.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')

export function MessageItem({ item, showTime }: { item: ChatItem; showTime?: boolean }): React.JSX.Element | null {
  if (item.role === 'user') {
    return (
      <View style={{ alignItems: 'flex-end', marginVertical: 4 }}>
        <View style={s.user}>
          <Text style={{ color: C.text, fontSize: 15, lineHeight: 21 }}>{textOf(item)}</Text>
        </View>
        {showTime && <Text style={s.time}>{relativeTime(item.createdAt)}</Text>}
      </View>
    )
  }
  if (item.role === 'system') {
    const text = textOf(item)
    if (!text.trim()) return null
    return (
      <View style={s.system}>
        <Icon name={item.level === 'error' ? 'alert-circle-outline' : 'information-circle-outline'} size={13} color={item.level === 'error' ? C.danger : C.dim} />
        <Text style={{ color: item.level === 'error' ? C.danger : C.dim, fontSize: 12, flex: 1 }} numberOfLines={3}>
          {text}
        </Text>
      </View>
    )
  }
  const parts = item.blocks.filter((b) => (b.type === 'text' ? b.text.trim() : b.type !== 'thinking' || b.text.trim()))
  if (!parts.length) return null
  return (
    <View style={{ marginVertical: 4 }}>
      {parts.map((b, i) => {
        if (b.type === 'text') return <Markdown key={i} style={mdStyle}>{b.text}</Markdown>
        if (b.type === 'thinking') return <Text key={i} style={{ color: C.dim, fontSize: 12, fontStyle: 'italic', marginVertical: 2 }}>Thinking…</Text>
        if (b.type === 'image') return <Text key={i} style={{ color: C.muted, fontSize: 12 }}>[image: {b.image.name}]</Text>
        return <ToolBlock key={b.toolUseId} b={b} />
      })}
      {showTime && <Text style={[s.time, { alignSelf: 'flex-start' }]}>{relativeTime(item.createdAt)}</Text>}
    </View>
  )
}

/** Three pulsing dots while the agent works. */
export function Typing({ label = 'Working' }: { label?: string }): React.JSX.Element {
  const a = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current
  useEffect(() => {
    const loops = a.map((v, i) =>
      Animated.loop(Animated.sequence([Animated.delay(i * 160), Animated.timing(v, { toValue: 1, duration: 320, useNativeDriver: true }), Animated.timing(v, { toValue: 0.3, duration: 320, useNativeDriver: true }), Animated.delay(320 - i * 160)]))
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [a])
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {a.map((v, i) => (
          <Animated.View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent, opacity: v }} />
        ))}
      </View>
      <Text style={{ color: C.muted, fontSize: 12 }}>{label}…</Text>
    </View>
  )
}

export function PromptCard({ prompt, workspaceName }: { prompt: RemotePrompt; workspaceName?: string }): React.JSX.Element {
  const [chosen, setChosen] = useState<number[]>([])
  const [free, setFree] = useState('')
  const decide = (fn: () => void): void => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    fn()
  }
  if (prompt.kind === 'permission') {
    const r = prompt.request
    const input = typeof r.input === 'object' ? JSON.stringify(r.input, null, 2) : String(r.input)
    return (
      <View style={s.card}>
        <View style={s.cardHead}>
          <View style={s.cardIcon}>
            <Icon name="shield-checkmark-outline" size={16} color={C.warn} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Allow {r.toolName}?</Text>
            {workspaceName ? <Text style={T.small}>{workspaceName}</Text> : null}
          </View>
        </View>
        <Text style={[mono, s.pre, { maxHeight: 170 }]} numberOfLines={9}>
          {headline(r.input) && input.length > 200 ? headline(r.input) + '\n\n' : ''}
          {input.slice(0, 1500)}
        </Text>
        <View style={s.row}>
          <Button title="Allow" kind="ok" icon="checkmark" onPress={() => decide(() => answerPermission(r.requestId, 'allow'))} style={{ flex: 1 }} />
          <Button title="Deny" kind="danger" icon="close" onPress={() => decide(() => answerPermission(r.requestId, 'deny'))} style={{ flex: 1 }} />
        </View>
        {r.canAlwaysAllow && <Button title="Always allow this" kind="ghost" small onPress={() => decide(() => answerPermission(r.requestId, 'always'))} style={{ alignSelf: 'center' }} />}
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
    decide(() => answerQuestion(r.requestId, answers, labels.length ? undefined : free.trim() || undefined))
  }
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <View style={s.cardIcon}>
          <Icon name="help-circle-outline" size={16} color={C.warn} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>{q?.header || 'Question'}</Text>
          {workspaceName ? <Text style={T.small}>{workspaceName}</Text> : null}
        </View>
      </View>
      <Text style={[T.body, { marginBottom: 4 }]}>{q?.question}</Text>
      {(q?.options ?? []).map((o, i) => {
        const sel = chosen.includes(i)
        return (
          <Pressable
            key={i}
            onPress={() => {
              if (!q.multiSelect) return decide(() => answerQuestion(r.requestId, { [q.question]: o.label }))
              setChosen((c) => (sel ? c.filter((x) => x !== i) : [...c, i]))
            }}
            style={({ pressed }) => [s.opt, sel && { borderColor: C.accent, backgroundColor: 'rgba(124,156,255,.14)' }, pressed && { opacity: 0.8 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.text, fontWeight: '600', fontSize: 14 }}>{o.label}</Text>
              {o.description ? <Text style={T.small}>{o.description}</Text> : null}
            </View>
            <Icon name={sel ? 'checkmark-circle' : q.multiSelect ? 'ellipse-outline' : 'chevron-forward'} size={18} color={sel ? C.accent : C.dim} />
          </Pressable>
        )
      })}
      <View style={[s.row, { alignItems: 'center' }]}>
        <TextInput value={free} onChangeText={setFree} placeholder="Or answer in your own words" placeholderTextColor={C.dim} style={s.input} />
        <Button title="Send" kind="primary" onPress={submit} disabled={!chosen.length && !free.trim()} />
      </View>
      {!q?.multiSelect && q?.options?.length ? null : <Badge text={q?.multiSelect ? 'Pick one or more' : 'Free answer'} />}
    </View>
  )
}

const s = StyleSheet.create({
  user: { maxWidth: '86%', backgroundColor: 'rgba(91,124,255,.22)', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18, borderBottomRightRadius: 5 },
  time: { color: C.dim, fontSize: 11, marginTop: 3, marginHorizontal: 4 },
  system: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, alignSelf: 'center', maxWidth: '92%', marginVertical: 6, paddingHorizontal: 10 },
  tool: { borderWidth: 1, borderColor: C.border, borderRadius: R.md, backgroundColor: C.panel, marginVertical: 4, overflow: 'hidden' },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
  pre: { color: C.text, fontSize: 12, lineHeight: 17, padding: 10, backgroundColor: C.bg2, borderRadius: R.sm },
  card: { marginHorizontal: S.md, marginVertical: S.sm, padding: S.lg, borderWidth: 1, borderColor: 'rgba(251,191,36,.4)', backgroundColor: 'rgba(251,191,36,.05)', borderRadius: R.lg, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(251,191,36,.14)', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { color: C.text, fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', gap: 8, marginTop: 2 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: C.border2, backgroundColor: C.panel, borderRadius: R.md, padding: 12 },
  input: { flex: 1, borderWidth: 1, borderColor: C.border2, backgroundColor: C.panel, color: C.text, borderRadius: R.md, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 }
})
