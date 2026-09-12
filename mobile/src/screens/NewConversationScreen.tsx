import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import { C, MAX_W, R, S, T, pane } from '../theme'
import { Dot, Icon, IconButton } from '../ui'
import { clearCreated, createConversation, useStore } from '../store'
import type { RootStack } from '../App'

/** Start a conversation from the phone: pick a team, describe the task, and the Mac creates the workspace. */
export function NewConversationScreen(): React.JSX.Element {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>()
  const { params } = useRoute<RouteProp<RootStack, 'NewConversation'>>()
  const insets = useSafeAreaInsets()
  const spaces = useStore((s) => s.spaces)
  const connected = useStore((s) => s.connected)
  const created = useStore((s) => s.created)
  const [spaceId, setSpaceId] = useState<string | undefined>(() => spaces.find((s) => s.name === params?.space)?.id ?? spaces[0]?.id)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  // The Mac confirms with `created`; open that conversation and leave this screen.
  useEffect(() => {
    if (busy && created) {
      const id = created
      clearCreated()
      nav.replace('Chat', { workspaceId: id })
    }
  }, [busy, created, nav])
  // If the Mac never confirms (offline, error), let the person try again after a while.
  useEffect(() => {
    if (!busy) return
    const t = setTimeout(() => setBusy(false), 30000)
    return () => clearTimeout(t)
  }, [busy])

  const start = (): void => {
    if (!text.trim() || busy) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    setBusy(true)
    createConversation(spaceId, undefined, text.trim())
  }

  return (
    <View style={[s.root, { paddingTop: insets.top + 6 }]}>
      <View style={s.header}>
        <IconButton name="close" onPress={() => nav.goBack()} />
        <Text style={[T.h2, { flex: 1, fontSize: 16 }]}>New conversation</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Dot tone={connected ? 'on' : 'off'} size={7} />
          <Text style={T.small}>{connected ? 'Live' : 'Offline'}</Text>
        </View>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={pane}
        contentContainerStyle={{ padding: S.md, gap: S.md }} keyboardShouldPersistTaps="handled">
          {spaces.length > 1 && (
            <View>
              <Text style={s.label}>Team</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {spaces.map((sp) => (
                  <Pressable key={sp.id} onPress={() => setSpaceId(sp.id)} style={[s.space, spaceId === sp.id && { borderColor: sp.color, backgroundColor: C.panel2 }]}>
                    <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: sp.color }} />
                    <Text style={{ color: C.text, fontSize: 13 }}>{sp.name}</Text>
                    <Text style={{ color: C.dim, fontSize: 11 }}>{sp.repoCount} app{sp.repoCount === 1 ? '' : 's'}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          <View>
            <Text style={s.label}>What do you want to do?</Text>
            <TextInput
              autoFocus
              value={text}
              onChangeText={setText}
              editable={!busy}
              placeholder="Describe the task. The agent works in this team's repos and you follow along here."
              placeholderTextColor={C.dim}
              multiline
              style={s.input}
            />
          </View>
          <Text style={T.small}>The Mac creates a workspace in the chosen team and starts the agent on it. This can take a moment while it sets up the folders.</Text>
        </ScrollView>
        <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <Pressable onPress={start} disabled={!text.trim() || busy} style={({ pressed }) => [s.start, (!text.trim() || busy) && { opacity: 0.5 }, pressed && { opacity: 0.85 }]}>
            {busy ? (
              <>
                <Icon name="sync" size={15} color="#fff" />
                <Text style={s.startText}>Starting…</Text>
              </>
            ) : (
              <>
                <Icon name="arrow-up" size={16} color="#fff" />
                <Text style={s.startText}>Start</Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { alignSelf: 'center', width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: S.sm, paddingBottom: S.sm },
  label: { ...T.caption, marginBottom: 8 },
  space: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 9, borderRadius: R.md, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border2 },
  input: { minHeight: 140, borderWidth: 1, borderColor: C.border2, backgroundColor: C.panel, color: C.text, borderRadius: R.md, padding: 14, fontSize: 15, textAlignVertical: 'top' },
  footer: { paddingHorizontal: S.md, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  start: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: R.md, backgroundColor: C.accent2 },
  startText: { color: '#fff', fontWeight: '700', fontSize: 15 }
})
