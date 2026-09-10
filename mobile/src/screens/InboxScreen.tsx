import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { DrawerNavigationProp } from '@react-navigation/drawer'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { C, S, T } from '../theme'
import { Dot, EmptyState, Icon, IconButton, SpaceChip } from '../ui'
import { PromptCard } from '../components'
import { useStore } from '../store'
import { relativeTime } from '../util'
import type { DrawerParams, RootStack } from '../App'

/** Everything waiting on you: prompts an agent is blocked on, and conversations where the agent replied. */
export function InboxScreen(): React.JSX.Element {
  const nav = useNavigation<DrawerNavigationProp<DrawerParams>>()
  const prompts = useStore((s) => s.prompts)
  const workspaces = useStore((s) => s.workspaces)
  const nameOf = (id: string): string | undefined => workspaces.find((w) => w.id === id)?.name
  const promptIds = new Set(prompts.map((p) => p.request.workspaceId))
  const replied = workspaces.filter((w) => w.awaitingReply && !promptIds.has(w.id))
  const openChat = (id: string): void => nav.getParent<NativeStackNavigationProp<RootStack>>()?.navigate('Chat', { workspaceId: id })
  const empty = prompts.length === 0 && replied.length === 0
  return (
    <View style={s.root}>
      <View style={s.header}>
        <IconButton name="menu-outline" onPress={() => nav.openDrawer()} />
        <Text style={[T.h1, { flex: 1 }]}>Inbox</Text>
        {prompts.length > 0 && <Text style={T.small}>{prompts.length} waiting</Text>}
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {empty ? (
          <EmptyState icon="checkmark-done-outline" title="All clear" body="Permission prompts, questions and replies from your agents land here, and as notifications when you are away from the Mac." />
        ) : (
          <>
            {prompts.map((p) => (
              <PromptCard key={p.request.requestId} prompt={p} workspaceName={nameOf(p.request.workspaceId)} />
            ))}
            {replied.length > 0 && <Text style={s.section}>Replied · your move</Text>}
            {replied.map((w) => (
              <Pressable key={w.id} onPress={() => openChat(w.id)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.panel }]}>
                <Dot tone="need" size={9} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[T.h2, { flex: 1, fontSize: 15 }]} numberOfLines={1}>
                      {w.name}
                    </Text>
                    <Text style={{ color: C.dim, fontSize: 11 }}>{relativeTime(w.lastMessageAt)}</Text>
                  </View>
                  {w.space && (
                    <View style={{ marginTop: 3 }}>
                      <SpaceChip name={w.space.name} color={w.space.color} small />
                    </View>
                  )}
                  {w.lastText && (
                    <Text style={[T.small, { marginTop: 3 }]} numberOfLines={2}>
                      {w.lastText}
                    </Text>
                  )}
                </View>
                <Icon name="chevron-forward" size={16} color={C.dim} />
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingBottom: S.sm },
  section: { ...T.caption, paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: S.lg, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border }
})
