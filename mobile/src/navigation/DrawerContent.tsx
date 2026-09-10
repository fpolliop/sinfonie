/** The side menu: brand, the Mac's connection, inbox, workspace filters, spaces, settings and help. */
import React from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { DrawerContentComponentProps } from '@react-navigation/drawer'
import { C, R, S, T } from '../theme'
import { Brand, Dot, Icon, type IoniconName } from '../ui'
import { useStore } from '../store'
import type { WorkspaceFilter } from '../App'

function Item({ icon, label, active, count, color, onPress }: { icon?: IoniconName; label: string; active?: boolean; count?: number; color?: string; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.item, active && s.itemActive, pressed && { opacity: 0.8 }]}>
      {color ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color, marginHorizontal: 4 }} /> : <Icon name={icon ?? 'ellipse'} size={18} color={active ? C.accent : C.muted} />}
      <Text style={[s.itemLabel, active && { color: C.text }]} numberOfLines={1}>
        {label}
      </Text>
      {count ? (
        <View style={[s.count, active && { backgroundColor: C.accent }]}>
          <Text style={{ color: active ? '#fff' : C.text, fontSize: 11, fontWeight: '700' }}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

export function DrawerContent(props: DrawerContentComponentProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const connected = useStore((s) => s.connected)
  const host = useStore((s) => s.host)
  const workspaces = useStore((s) => s.workspaces)
  const prompts = useStore((s) => s.prompts)
  const onCall = useStore((s) => s.onCall)
  const route = props.state.routes[props.state.index]
  const params = (route.params ?? {}) as { filter?: WorkspaceFilter; space?: string }
  const onWorkspaces = route.name === 'Workspaces'
  const spaces = Array.from(new Map(workspaces.filter((w) => w.space).map((w) => [w.space!.name, w.space!])).values())
  const needs = new Set(prompts.map((p) => p.request.workspaceId))
  const needCount = workspaces.filter((w) => w.needsInput || needs.has(w.id) || w.awaitingReply).length
  const inboxCount = prompts.length + workspaces.filter((w) => w.awaitingReply && !needs.has(w.id)).length
  const running = workspaces.filter((w) => w.busy).length
  const onCallNeeds = onCall.filter((i) => (i.needsHuman || i.proposals.some((p) => p.status === 'proposed')) && i.status !== 'resolved' && i.status !== 'dismissed').length
  const go = (name: string, p?: object): void => {
    ;(props.navigation.navigate as unknown as (n: string, p?: object) => void)(name, p)
    props.navigation.closeDrawer()
  }

  return (
    <View style={[s.root, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 10 }]}>
      <View style={{ paddingHorizontal: S.lg, marginBottom: S.md }}>
        <Brand size={30} />
      </View>
      <Pressable onPress={() => go('Settings')} style={({ pressed }) => [s.mac, pressed && { opacity: 0.8 }]}>
        <View style={s.macIcon}>
          <Icon name="laptop-outline" size={18} color={C.text} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[T.h2, { fontSize: 14 }]} numberOfLines={1}>
            {host || 'Your Mac'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <Dot tone={connected ? 'on' : 'off'} size={6} />
            <Text style={T.small}>{connected ? 'Connected' : 'Reconnecting…'}</Text>
          </View>
        </View>
        <Icon name="chevron-forward" size={14} color={C.dim} />
      </Pressable>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: S.sm }} showsVerticalScrollIndicator={false}>
        <Item icon="notifications-outline" label="Inbox" count={inboxCount} active={route.name === 'Inbox'} onPress={() => go('Inbox')} />
        <Item icon="git-pull-request-outline" label="Reviews" active={route.name === 'Reviews'} onPress={() => go('Reviews')} />
        <Item icon="pulse-outline" label="On call" count={onCallNeeds} active={route.name === 'OnCall'} onPress={() => go('OnCall')} />
        <Text style={s.section}>Workspaces</Text>
        <Item icon="albums-outline" label="All workspaces" count={workspaces.length} active={onWorkspaces && !params.filter && !params.space} onPress={() => go('Workspaces', { filter: undefined, space: undefined })} />
        <Item icon="hand-left-outline" label="Needs you" count={needCount} active={onWorkspaces && params.filter === 'needs'} onPress={() => go('Workspaces', { filter: 'needs', space: undefined })} />
        <Item icon="flash-outline" label="Running" count={running} active={onWorkspaces && params.filter === 'running'} onPress={() => go('Workspaces', { filter: 'running', space: undefined })} />
        {spaces.length > 0 && <Text style={s.section}>Spaces</Text>}
        {spaces.map((sp) => (
          <Item key={sp.name} label={sp.name} color={sp.color} count={workspaces.filter((w) => w.space?.name === sp.name).length} active={onWorkspaces && params.space === sp.name} onPress={() => go('Workspaces', { filter: undefined, space: sp.name })} />
        ))}
      </ScrollView>

      <View style={{ borderTopWidth: 1, borderTopColor: C.border, paddingTop: S.sm }}>
        <Item icon="settings-outline" label="Settings" active={route.name === 'Settings'} onPress={() => go('Settings')} />
        <Item icon="help-buoy-outline" label="Help & feedback" onPress={() => void Linking.openURL('https://sinfonie.dev/support')} />
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg2 },
  mac: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: S.md, padding: 12, borderRadius: R.lg, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border },
  macIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center' },
  section: { ...T.caption, paddingHorizontal: S.lg + 4, paddingTop: S.lg, paddingBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: S.sm, paddingHorizontal: 12, paddingVertical: 10, borderRadius: R.md },
  itemActive: { backgroundColor: 'rgba(124,156,255,.12)' },
  itemLabel: { flex: 1, color: C.muted, fontSize: 15, fontWeight: '500' },
  count: { minWidth: 22, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center' }
})
