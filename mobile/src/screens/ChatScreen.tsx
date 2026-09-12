import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import { C, MAX_W, R, S, T, pane } from '../theme'
import { Dot, Icon, IconButton, SpaceChip } from '../ui'
import { MessageItem, PromptCard, Typing } from '../components'
import { loadHistory, send, sendMessage, subscribe, unsubscribe, useStore } from '../store'
import { dismissForWorkspace } from '../notifications'
import type { RootStack } from '../App'

export function ChatScreen(): React.JSX.Element {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>()
  const { params } = useRoute<RouteProp<RootStack, 'Chat'>>()
  const id = params.workspaceId
  const insets = useSafeAreaInsets()
  const ws = useStore((s) => s.workspaces.find((w) => w.id === id))
  const items = useStore((s) => s.transcripts[id])
  const hasMore = useStore((s) => s.transcriptHasMore[id] ?? false)
  const loadingHistory = useStore((s) => s.loadingHistory[id] ?? false)
  const busyFlag = useStore((s) => s.busy[id])
  const connected = useStore((s) => s.connected)
  const prompts = useStore((s) => s.prompts.filter((p) => p.request.workspaceId === id))
  const busy = busyFlag ?? ws?.busy ?? false
  const [text, setText] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [slow, setSlow] = useState(false)
  const list = useRef<FlatList>(null)
  const didInitial = useRef(false) // scrolled to the latest message for the transcript now shown
  const contentH = useRef(0)
  const scrollY = useRef(0)
  const prependAnchor = useRef<{ height: number; y: number } | null>(null) // set while a history page is loading, to keep the view put

  useEffect(() => {
    subscribe(id)
    void dismissForWorkspace(id) // opening it here clears its notifications from the tray too
    return () => unsubscribe(id)
  }, [id])
  // A fresh conversation must open at the latest message. Force it to the bottom the first time the
  // transcript lands (a few times, since message heights settle after layout), independent of atBottom.
  useEffect(() => {
    didInitial.current = false
  }, [id])
  useEffect(() => {
    if (!items || items.length === 0 || didInitial.current) return
    didInitial.current = true
    setAtBottom(true)
    const timers = [0, 80, 220, 450].map((t) => setTimeout(() => list.current?.scrollToEnd({ animated: false }), t))
    return () => timers.forEach(clearTimeout)
  }, [items, id])
  // The transcript arrives in reply to `subscribe`. A subscribe sent while the socket is reconnecting is
  // dropped, so re-request until it lands (and again whenever the connection comes back), and surface a
  // slow/offline hint instead of an endless "Loading…".
  useEffect(() => {
    if (items !== undefined) {
      setSlow(false)
      return
    }
    setSlow(false)
    const retries = [1500, 4000, 8000].map((ms) => setTimeout(() => subscribe(id), ms))
    const slowTimer = setTimeout(() => setSlow(true), 6000)
    return () => {
      retries.forEach(clearTimeout)
      clearTimeout(slowTimer)
    }
  }, [id, items, connected])
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
          style={pane}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12 }}
          renderItem={({ item, index }) => <MessageItem item={item} showTime={index === (items?.length ?? 0) - 1} />}
          onStartReached={() => {
            if (hasMore && !loadingHistory && (items?.length ?? 0) > 0) {
              prependAnchor.current = { height: contentH.current, y: scrollY.current }
              loadHistory(id)
            }
          }}
          onStartReachedThreshold={0.4}
          ListHeaderComponent={
            items && items.length > 0 && (loadingHistory || hasMore) ? (
              <View style={{ alignItems: 'center', paddingVertical: 10, gap: 6 }}>
                {loadingHistory ? <ActivityIndicator color={C.dim} size="small" /> : <Text style={[T.small, { color: C.dim }]}>Scroll up for earlier messages</Text>}
              </View>
            ) : null
          }
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
            scrollY.current = contentOffset.y
            contentH.current = contentSize.height
            setAtBottom(contentSize.height - contentOffset.y - layoutMeasurement.height < 140)
          }}
          scrollEventThrottle={100}
          ListEmptyComponent={
            items ? (
              <View style={{ alignItems: 'center', paddingTop: 60, gap: 8 }}>
                <Icon name="chatbubble-ellipses-outline" size={28} color={C.dim} />
                <Text style={T.small}>No messages yet. Say what you need.</Text>
              </View>
            ) : (
              <View style={{ alignItems: 'center', paddingTop: 60, gap: 10 }}>
                <ActivityIndicator color={C.muted} />
                <Text style={T.small}>Loading the conversation…</Text>
                {slow && (
                  <>
                    <Text style={[T.small, { color: C.dim, textAlign: 'center', maxWidth: 260 }]}>
                      {connected ? 'Taking longer than usual. The Mac may be busy or asleep.' : 'Offline. Reconnecting to your Mac…'}
                    </Text>
                    <Pressable onPress={() => subscribe(id)} style={s.retry}>
                      <Icon name="refresh" size={14} color={C.text} />
                      <Text style={{ color: C.text, fontSize: 13, fontWeight: '600' }}>Try again</Text>
                    </Pressable>
                  </>
                )}
              </View>
            )
          }
          ListFooterComponent={
            <View>
              {busy && <Typing />}
              {prompts.map((p) => (
                <PromptCard key={p.request.requestId} prompt={p} />
              ))}
            </View>
          }
          onContentSizeChange={(_w, h) => {
            // A history page just prepended: keep the reader on the same message by adding the new height.
            if (prependAnchor.current) {
              const delta = h - prependAnchor.current.height
              if (delta > 0) list.current?.scrollToOffset({ offset: prependAnchor.current.y + delta, animated: false })
              prependAnchor.current = null
              contentH.current = h
              return
            }
            contentH.current = h
            if (atBottom) list.current?.scrollToEnd({ animated: false })
          }}
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
  header: { alignSelf: 'center', width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: S.sm, paddingBottom: S.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, backgroundColor: C.bg },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: R.pill, backgroundColor: 'rgba(248,113,113,.14)', borderWidth: 1, borderColor: 'rgba(248,113,113,.35)' },
  toBottom: { position: 'absolute', right: 14, bottom: 84, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 34, borderRadius: 17, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border2 },
  composer: { alignSelf: 'center', width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.bg },
  input: { flex: 1, maxHeight: 130, minHeight: 42, borderWidth: 1, borderColor: C.border2, backgroundColor: C.panel, color: C.text, borderRadius: 21, paddingHorizontal: 15, paddingTop: 11, paddingBottom: 11, fontSize: 15 },
  send: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent2, alignItems: 'center', justifyContent: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: R.pill, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border2, marginTop: 2 }
})
