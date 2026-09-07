import React from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { DrawerNavigationProp } from '@react-navigation/drawer'
import { C, S, T } from '../theme'
import { EmptyState, IconButton } from '../ui'
import { PromptCard } from '../components'
import { useStore } from '../store'
import type { DrawerParams } from '../App'

/** Every prompt an agent is waiting on, across workspaces. */
export function InboxScreen(): React.JSX.Element {
  const nav = useNavigation<DrawerNavigationProp<DrawerParams>>()
  const prompts = useStore((s) => s.prompts)
  const workspaces = useStore((s) => s.workspaces)
  const nameOf = (id: string): string | undefined => workspaces.find((w) => w.id === id)?.name
  return (
    <View style={s.root}>
      <View style={s.header}>
        <IconButton name="menu-outline" onPress={() => nav.openDrawer()} />
        <Text style={[T.h1, { flex: 1 }]}>Inbox</Text>
        {prompts.length > 0 && <Text style={T.small}>{prompts.length} waiting</Text>}
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {prompts.length === 0 ? (
          <EmptyState icon="checkmark-done-outline" title="All clear" body="Permission prompts and questions from your agents land here, and as notifications when you are away from the Mac." />
        ) : (
          prompts.map((p) => <PromptCard key={p.request.requestId} prompt={p} workspaceName={nameOf(p.request.workspaceId)} />)
        )}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingBottom: S.sm }
})
