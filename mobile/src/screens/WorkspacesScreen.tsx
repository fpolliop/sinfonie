import React, { useCallback, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { DrawerNavigationProp } from '@react-navigation/drawer'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { C, S, T } from '../theme'
import { Badge, Button, Dot, EmptyState, IconButton, SpaceChip } from '../ui'
import { PromptCard } from '../components'
import { send, useStore } from '../store'
import { enablePush } from '../notifications'
import { relativeTime } from '../util'
import type { DrawerParams, RootStack } from '../App'
import type { RemoteWorkspace } from '../protocol'

export function WorkspacesScreen(): React.JSX.Element {
  const nav = useNavigation<DrawerNavigationProp<DrawerParams>>()
  const { params } = useRoute<RouteProp<DrawerParams, 'Workspaces'>>()
  const filter = params?.filter
  const space = params?.space
  const workspaces = useStore((s) => s.workspaces)
  const prompts = useStore((s) => s.prompts)
  const connected = useStore((s) => s.connected)
  const lastError = useStore((s) => s.lastError)
  const [refreshing, setRefreshing] = useState(false)
  const [pushState, setPushState] = useState<'off' | 'on' | 'failed' | 'hidden'>('off')
  const [pushMsg, setPushMsg] = useState<string | null>(null)

  const needs = useMemo(() => new Set(prompts.map((p) => p.request.workspaceId)), [prompts])
  const visible = useMemo(() => {
    let list = workspaces
    if (space) list = list.filter((w) => w.space?.name === space)
    if (filter === 'needs') list = list.filter((w) => w.needsInput || needs.has(w.id))
    if (filter === 'running') list = list.filter((w) => w.busy)
    return list
  }, [workspaces, filter, space, needs])
  const sections = useMemo(() => {
    if (filter) return [{ title: '', data: visible }]
    const need = visible.filter((w) => w.needsInput || needs.has(w.id))
    const running = visible.filter((w) => w.busy && !need.includes(w))
    const rest = visible.filter((w) => !need.includes(w) && !running.includes(w))
    return [
      { title: 'Needs you', data: need },
      { title: 'Running', data: running },
      { title: need.length || running.length ? 'Idle' : '', data: rest }
    ].filter((sec) => sec.data.length)
  }, [visible, filter, needs])
  const title = space ?? (filter === 'needs' ? 'Needs you' : filter === 'running' ? 'Running' : 'Workspaces')

  const refresh = useCallback(() => {
    setRefreshing(true)
    send({ type: 'sync' })
    setTimeout(() => setRefreshing(false), 700)
  }, [])
  const openPrompts = prompts.filter((p) => !space || workspaces.find((w) => w.id === p.request.workspaceId)?.space?.name === space)

  return (
    <View style={s.root}>
      <View style={s.header}>
        <IconButton name="menu-outline" onPress={() => nav.openDrawer()} badge={prompts.length} />
        <Text style={[T.h1, { flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
        <Pressable onPress={() => nav.navigate('Settings')} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6 }}>
          <Dot tone={connected ? 'on' : 'off'} size={7} />
          <Text style={T.small}>{connected ? 'Live' : 'Offline'}</Text>
        </Pressable>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(w) => w.id}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.muted} />}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListHeaderComponent={
          <View>
            {lastError && (
              <View style={s.notice}>
                <Text style={{ color: C.warn, fontSize: 12, flex: 1 }}>{lastError}</Text>
              </View>
            )}
            {pushState !== 'on' && pushState !== 'hidden' && (
              <View style={s.banner}>
                <View style={{ flex: 1 }}>
                  <Text style={[T.h2, { fontSize: 14 }]}>Notifications</Text>
                  <Text style={T.small}>{pushMsg ?? 'Get a push when an agent waits for you, even with the app closed.'}</Text>
                </View>
                <Button title="Enable" kind="primary" small onPress={() => void enablePush().then((r) => { setPushState(r.ok ? 'on' : 'failed'); setPushMsg(r.ok ? null : r.reason ?? null) })} />
                <IconButton name="close" size={16} color={C.dim} onPress={() => setPushState('hidden')} style={{ width: 28, height: 28 }} />
              </View>
            )}
            {!filter && !space && openPrompts.map((p) => <PromptCard key={p.request.requestId} prompt={p} workspaceName={workspaces.find((w) => w.id === p.request.workspaceId)?.name} />)}
          </View>
        }
        renderSectionHeader={({ section }) => (section.title ? <Text style={s.sectionTitle}>{section.title}</Text> : null)}
        ListEmptyComponent={
          <EmptyState
            icon={filter === 'needs' ? 'checkmark-done-outline' : filter === 'running' ? 'moon-outline' : 'albums-outline'}
            title={filter === 'needs' ? 'Nothing needs you' : filter === 'running' ? 'No agent is running' : 'No workspaces'}
            body={filter ? 'Come back when an agent asks for something, or pull to refresh.' : 'Create a workspace in Sinfonie on the Mac and it appears here.'}
          />
        }
        renderItem={({ item: w }) => <WorkspaceRow w={w} need={needs.has(w.id) || w.needsInput} onPress={() => nav.getParent<NativeStackNavigationProp<RootStack>>()?.navigate('Chat', { workspaceId: w.id })} />}
      />
    </View>
  )
}

function WorkspaceRow({ w, need, onPress }: { w: RemoteWorkspace; need: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.panel }]}>
      <View style={[s.avatar, { borderColor: w.space?.color ?? C.border2 }]}>
        <Text style={{ color: w.space?.color ?? C.muted, fontWeight: '700', fontSize: 14 }}>{w.name.trim()[0]?.toUpperCase() ?? '·'}</Text>
        <View style={s.avatarDot}>
          <Dot tone={need ? 'need' : w.busy ? 'busy' : 'idle'} size={9} />
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[T.h2, { flex: 1 }]} numberOfLines={1}>
            {w.name}
          </Text>
          <Text style={{ color: C.dim, fontSize: 11 }}>{relativeTime(w.lastMessageAt)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
          {w.space && <SpaceChip name={w.space.name} color={w.space.color} small />}
          {need ? <Badge text="needs you" tone="warn" /> : w.busy ? <Badge text="running" tone="accent" /> : null}
        </View>
        <Text style={[T.small, { marginTop: 3 }]} numberOfLines={2}>
          {w.lastText || (w.status === 'creating' ? 'Creating the workspace…' : 'No messages yet')}
        </Text>
      </View>
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingBottom: S.sm },
  notice: { flexDirection: 'row', marginHorizontal: S.md, marginBottom: S.sm, padding: 10, borderRadius: 10, backgroundColor: 'rgba(251,191,36,.08)', borderWidth: 1, borderColor: 'rgba(251,191,36,.3)' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: S.md, marginBottom: S.sm, padding: 12, borderRadius: 14, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border },
  sectionTitle: { ...T.caption, paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.xs },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: S.lg, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  avatar: { width: 42, height: 42, borderRadius: 13, backgroundColor: C.panel, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  avatarDot: { position: 'absolute', right: -3, bottom: -3, padding: 2, borderRadius: 8, backgroundColor: C.bg }
})
