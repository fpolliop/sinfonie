import React, { useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Badge, Btn, Dot, PromptCard } from '../components'
import { C } from '../theme'
import { useStore } from '../store'
import { enablePush } from '../notifications'
import type { RootStack } from '../App'

export function WorkspacesScreen(): React.JSX.Element {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>()
  const workspaces = useStore((s) => s.workspaces)
  const prompts = useStore((s) => s.prompts)
  const connected = useStore((s) => s.connected)
  const host = useStore((s) => s.host)
  const lastError = useStore((s) => s.lastError)
  const [pushState, setPushState] = useState<'unknown' | 'off' | 'on' | 'failed'>('unknown')
  const [pushMsg, setPushMsg] = useState<string | null>(null)
  useEffect(() => {
    nav.setOptions({
      title: 'Sinfonie',
      headerRight: () => (
        <Pressable onPress={() => nav.navigate('Settings')} hitSlop={10}>
          <Text style={{ color: C.accent, fontSize: 15 }}>Settings</Text>
        </Pressable>
      )
    })
  }, [nav])

  const nameOf = (id: string): string | undefined => workspaces.find((w) => w.id === id)?.name
  const needs = new Set(prompts.map((p) => p.request.workspaceId))

  return (
    <View style={s.root}>
      <FlatList
        data={workspaces}
        keyExtractor={(w) => w.id}
        ListHeaderComponent={
          <View>
            <View style={s.status}>
              <Dot tone={connected ? 'on' : 'idle'} />
              <Text style={{ color: C.muted, fontSize: 12 }}>{connected ? (host ? `Connected to ${host}` : 'Connected') : 'Connecting to the relay…'}</Text>
            </View>
            {lastError && <Text style={{ color: C.warn, fontSize: 12, paddingHorizontal: 14, paddingBottom: 6 }}>{lastError}</Text>}
            {pushState !== 'on' && (
              <View style={s.banner}>
                <Text style={{ color: C.muted, fontSize: 13, flex: 1 }}>{pushMsg ?? 'Get a push when an agent waits for you.'}</Text>
                <Btn
                  title="Enable notifications"
                  kind="primary"
                  onPress={() => {
                    void enablePush().then((r) => {
                      setPushState(r.ok ? 'on' : 'failed')
                      setPushMsg(r.ok ? null : r.reason ?? null)
                    })
                  }}
                />
              </View>
            )}
            {prompts.map((p) => (
              <PromptCard key={p.request.requestId} prompt={p} workspaceName={nameOf(p.request.workspaceId)} />
            ))}
          </View>
        }
        ListEmptyComponent={
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Text style={{ color: C.text, fontSize: 17, fontWeight: '600' }}>No workspaces</Text>
            <Text style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>Create one in Sinfonie on the Mac and it appears here.</Text>
          </View>
        }
        renderItem={({ item: w }) => {
          const need = needs.has(w.id) || w.needsInput
          return (
            <Pressable onPress={() => nav.navigate('Chat', { workspaceId: w.id })} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.panel }]}>
              <View style={{ marginTop: 7 }}>
                <Dot tone={need ? 'need' : w.busy ? 'busy' : 'idle'} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={s.name}>{w.name}</Text>
                  {w.space && <Text style={{ color: w.space.color, fontSize: 11 }}>{w.space.name}</Text>}
                  {need ? <Badge text="needs you" tone="warn" /> : w.busy ? <Badge text="running" tone="accent" /> : null}
                </View>
                <Text style={s.last} numberOfLines={2}>
                  {w.lastText || (w.status === 'creating' ? 'Creating…' : 'No messages yet')}
                </Text>
              </View>
            </Pressable>
          )
        }}
      />
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  banner: { margin: 12, padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 10, backgroundColor: C.panel, gap: 10, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  name: { color: C.text, fontWeight: '600', fontSize: 15 },
  last: { color: C.muted, fontSize: 13, marginTop: 2 }
})
