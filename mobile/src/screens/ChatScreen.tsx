import React, { useEffect, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Btn, MessageItem, PromptCard } from '../components'
import { C } from '../theme'
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
  const list = useRef<FlatList>(null)

  useEffect(() => {
    subscribe(id)
    return () => unsubscribe(id)
  }, [id])
  useEffect(() => {
    nav.setOptions({
      title: ws?.name ?? 'Workspace',
      headerRight: () =>
        busy ? (
          <Pressable onPress={() => send({ type: 'interrupt', workspaceId: id })} hitSlop={10}>
            <Text style={{ color: C.danger, fontSize: 15 }}>Stop</Text>
          </Pressable>
        ) : null
    })
  }, [nav, ws?.name, busy, id])
  useEffect(() => {
    const t = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50)
    return () => clearTimeout(t)
  }, [items?.length, prompts.length, busy])

  const doSend = (): void => {
    const t = text.trim()
    if (!t) return
    sendMessage(id, t)
    setText('')
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <FlatList
        ref={list}
        data={items ?? []}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 }}
        renderItem={({ item }) => <MessageItem item={item} />}
        ListEmptyComponent={<Text style={{ color: C.muted, textAlign: 'center', marginTop: 24 }}>{items ? 'No messages yet. Say what you need.' : 'Loading…'}</Text>}
        ListFooterComponent={
          <View>
            {busy && <Text style={{ color: C.muted, fontSize: 12, paddingVertical: 4 }}>Working…</Text>}
            {prompts.map((p) => (
              <PromptCard key={p.request.requestId} prompt={p} />
            ))}
          </View>
        }
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
      />
      <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TextInput value={text} onChangeText={setText} placeholder="Message" placeholderTextColor={C.dim} multiline style={s.input} />
        <Btn title="Send" kind="primary" onPress={doSend} disabled={!text.trim()} />
      </View>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  input: { flex: 1, maxHeight: 120, minHeight: 40, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel, color: C.text, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15 }
})
