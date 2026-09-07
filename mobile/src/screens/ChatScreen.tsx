import React, { useEffect, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import { C, R, S, T } from '../theme'
import { Dot, Icon, IconButton, SpaceChip } from '../ui'
import { MessageItem, PromptCard, Typing } from '../components'
import { send, sendMessage, subscribe, unsubscribe, useStore } from '../store'
import type { RootStack } from '../App'

export function ChatScreen(): React.JSX.Element {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>()
  const { params } = useRoute<RouteProp<RootStack, 'Chat'>>()
  const id = params.workspaceId
  const insets = useSafeAreaInsets()
  const ws = useStore((s) => s.workspaces.find((w) => w.id === id))
  const items = useStore((s) => s.transcripts[id])
  const busyFlag = useStore((s) => s.busy[id])
  const prompts = useStore((s) => s.prompts.filter((p) => p.request.workspaceId === id))
  const busy = busyFlag ?? ws?.busy ?? false
  const [text, setText] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const list = useRef<FlatList>(null)

  useEffect(() => {
    subscribe(id)
    return () => unsubscribe(id)
  }, [id])
  useEffect(() => {
    if (atBottom) {
      const t = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 60)
      return () => clearTimeout(t)
    }
  }, [items?.length, prompts.length, busy, atBottom])

  const doSend = (): void => {
    const t = text.trim()
    if (!t) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    sendMessage(id, t)
    setText('')
    setAtBottom(true)
  }
  const stop = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    send({ type: 'interrupt', workspaceId: id })
  }

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 4 }]}>
        <IconButton name="chevron-back" onPress={() => nav.goBack()} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[T.h2, { fontSize: 16 }]} numberOfLines={1}>
            {ws?.name ?? 'Workspace'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {ws?.space && <SpaceChip name={ws.space.name} color={ws.space.color} small />}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Dot tone={busy ? 'busy' : prompts.length ? 'need' : 'idle'} size={6} />
              <Text style={{ color: C.muted, fontSize: 11 }}>{prompts.length ? 'waiting for you' : busy ? 'working' : 'idle'}</Text>
            </View>
          </View>
        </View>
        {busy ? (
          <Pressable onPress={stop} style={({ pressed }) => [s.stop, pressed && { opacity: 0.7 }]}>
            <Icon name="stop" size={12} color={C.danger} />
            <Text style={{ color: C.danger, fontWeight: '600', fontSize: 13 }}>Stop</Text>
          </Pressable>
        ) : (
          <View style={{ width: 38 }} />
        )}
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
        <FlatList
          ref={list}
          data={items ?? []}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12 }}
          renderItem={({ item, index }) => <MessageItem item={item} showTime={index === (items?.length ?? 0) - 1} />}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
            setAtBottom(contentSize.height - contentOffset.y - layoutMeasurement.height < 140)
          }}
          scrollEventThrottle={100}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 60, gap: 8 }}>
              <Icon name={items ? 'chatbubble-ellipses-outline' : 'cloud-download-outline'} size={28} color={C.dim} />
              <Text style={T.small}>{items ? 'No messages yet. Say what you need.' : 'Loading the conversation…'}</Text>
            </View>
          }
          ListFooterComponent={
            <View>
              {busy && <Typing />}
              {prompts.map((p) => (
                <PromptCard key={p.request.requestId} prompt={p} />
              ))}
            </View>
          }
          onContentSizeChange={() => atBottom && list.current?.scrollToEnd({ animated: false })}
        />
        {!atBottom && (
          <Pressable onPress={() => { setAtBottom(true); list.current?.scrollToEnd({ animated: true }) }} style={s.toBottom}>
            <Icon name="arrow-down" size={16} color={C.text} />
            {prompts.length > 0 && <Dot tone="need" size={7} />}
          </Pressable>
        )}
        <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <TextInput value={text} onChangeText={setText} placeholder={busy ? 'Queue a message…' : 'Message the agent'} placeholderTextColor={C.dim} multiline style={s.input} />
          <Pressable onPress={doSend} disabled={!text.trim()} style={({ pressed }) => [s.send, !text.trim() && { opacity: 0.4 }, pressed && { opacity: 0.8 }]}>
            <Icon name="arrow-up" size={18} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: S.sm, paddingBottom: S.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, backgroundColor: C.bg },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: R.pill, backgroundColor: 'rgba(248,113,113,.14)', borderWidth: 1, borderColor: 'rgba(248,113,113,.35)' },
  toBottom: { position: 'absolute', right: 14, bottom: 84, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 34, borderRadius: 17, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border2 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.bg },
  input: { flex: 1, maxHeight: 130, minHeight: 42, borderWidth: 1, borderColor: C.border2, backgroundColor: C.panel, color: C.text, borderRadius: 21, paddingHorizontal: 15, paddingTop: 11, paddingBottom: 11, fontSize: 15 },
  send: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent2, alignItems: 'center', justifyContent: 'center' }
})
