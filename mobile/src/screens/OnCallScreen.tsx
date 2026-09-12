import React, { useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { DrawerNavigationProp } from '@react-navigation/drawer'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { C, MAX_W, R, S, T } from '../theme'
import { Badge, Dot, EmptyState, Icon, IconButton } from '../ui'
import { refreshOnCall, useStore } from '../store'
import { relativeTime } from '../util'
import type { DrawerParams, RootStack } from '../App'
import type { RemoteIncident, Severity } from '../protocol'

type OnCallView = 'open' | 'needs' | 'done' | 'all'
const VIEWS: { id: OnCallView; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'needs', label: 'Needs you' },
  { id: 'done', label: 'Resolved' },
  { id: 'all', label: 'All' }
]
const ACTIVE = ['new', 'triaging', 'open', 'waiting']
const sevTone = (s?: Severity): 'danger' | 'warn' | 'accent' | 'muted' => (s === 'critical' ? 'danger' : s === 'high' ? 'warn' : s === 'medium' ? 'accent' : 'muted')
const needsYou = (i: RemoteIncident): boolean => i.needsHuman || i.proposals.some((p) => p.status === 'proposed')

/** On-call incidents across your teams: Slack-sourced, triaged on the Mac. Tap one to act on it. */
export function OnCallScreen(): React.JSX.Element {
  const nav = useNavigation<DrawerNavigationProp<DrawerParams>>()
  const onCall = useStore((s) => s.onCall)
  const running = useStore((s) => s.onCallRunning)
  const connected = useStore((s) => s.connected)
  const [view, setView] = useState<OnCallView>('open')
  const [space, setSpace] = useState<string | null>(null)
  const [loading, setLoading] = useState(onCall.length === 0)
  useEffect(() => {
    refreshOnCall()
    const t = setTimeout(() => setLoading(false), 10000)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    if (onCall.length) setLoading(false)
  }, [onCall])
  const refresh = (): void => {
    setLoading(true)
    refreshOnCall()
    setTimeout(() => setLoading(false), 8000)
  }
  const spaces = useMemo(() => Array.from(new Map(onCall.filter((i) => i.space).map((i) => [i.space!.name, i.space!])).values()), [onCall])
  const visible = useMemo(() => {
    let list = onCall
    if (space) list = list.filter((i) => i.space?.name === space)
    if (view === 'open') list = list.filter((i) => ACTIVE.includes(i.status))
    else if (view === 'needs') list = list.filter(needsYou)
    else if (view === 'done') list = list.filter((i) => i.status === 'resolved' || i.status === 'dismissed')
    return [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }, [onCall, view, space])
  const openCount = onCall.filter((i) => ACTIVE.includes(i.status)).length

  return (
    <View style={s.root}>
      <View style={s.header}>
        <IconButton name="menu-outline" onPress={() => nav.openDrawer()} />
        <Text style={[T.h1, { flex: 1 }]}>On call</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Dot tone={running ? 'on' : connected ? 'idle' : 'off'} size={7} />
          <Text style={T.small}>{running ? `${openCount} open` : connected ? 'Paused' : 'Offline'}</Text>
        </View>
      </View>
      <View style={s.controls}>
        {VIEWS.map((v) => (
          <Chip key={v.id} label={v.label} active={view === v.id} onPress={() => setView(v.id)} />
        ))}
      </View>
      {spaces.length > 1 && (
        <View style={[s.controls, { paddingTop: 0 }]}>
          <Chip label="All spaces" active={space === null} onPress={() => setSpace(null)} />
          {spaces.map((sp) => (
            <Chip key={sp.name} label={sp.name} color={sp.color} active={space === sp.name} onPress={() => setSpace(space === sp.name ? null : sp.name)} />
          ))}
        </View>
      )}
      <FlatList
        data={visible}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingBottom: 32, width: '100%', maxWidth: MAX_W, alignSelf: 'center' }}
        refreshControl={<RefreshControl refreshing={loading && onCall.length > 0} onRefresh={refresh} tintColor={C.muted} />}
        renderItem={({ item }) => <IncidentRow inc={item} onPress={() => nav.getParent<NativeStackNavigationProp<RootStack>>()?.navigate('Incident', { id: item.id })} />}
        ListEmptyComponent={
          loading ? (
            <EmptyState icon="cloud-download-outline" title="Loading incidents…" body="Gathering the incidents your Mac is watching across your teams." />
          ) : running ? (
            <EmptyState icon="shield-checkmark-outline" title="All quiet" body="No incidents in this view. New alerts and support messages from your watched channels show up here." />
          ) : (
            <EmptyState icon="pause-circle-outline" title="On call is off" body="Turn on on-call watching for a space on your Mac, and incidents will appear here." />
          )
        }
      />
    </View>
  )
}

function IncidentRow({ inc, onPress }: { inc: RemoteIncident; onPress: () => void }): React.JSX.Element {
  const triaged = inc.status !== 'new' && inc.status !== 'triaging'
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.panel }]}>
      <View style={s.icon}>
        <Icon name={inc.kind === 'alerts' ? 'pulse-outline' : 'chatbubble-ellipses-outline'} size={18} color={C.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[T.h2, { flex: 1, fontSize: 15 }]} numberOfLines={2}>
            {inc.title}
          </Text>
          {inc.severity ? <Badge text={inc.severity} tone={sevTone(inc.severity)} /> : !triaged ? <Badge text="triaging" tone="muted" /> : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          {inc.space && <SpaceDot name={inc.space.name} color={inc.space.color} />}
          <Text style={{ color: C.muted, fontSize: 12 }}>#{inc.channelName}</Text>
          {inc.occurrences && inc.occurrences > 1 ? <Text style={{ color: C.warn, fontSize: 12 }}>×{inc.occurrences}</Text> : null}
          <Text style={{ color: C.dim, fontSize: 12 }}>· {relativeTime(inc.updatedAt)}</Text>
          {needsYou(inc) && <Badge text="needs you" tone="warn" icon="hand-left-outline" />}
        </View>
      </View>
      <Icon name="chevron-forward" size={16} color={C.dim} />
    </Pressable>
  )
}

function SpaceDot({ name, color }: { name: string; color: string }): React.JSX.Element {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: C.dim, fontSize: 12 }}>{name}</Text>
    </View>
  )
}

function Chip({ label, active, color, onPress }: { label: string; active: boolean; color?: string; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={[s.chip, active && s.chipOn]} hitSlop={4}>
      {color && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, marginRight: 6 }} />}
      <Text style={{ color: active ? C.accent : C.muted, fontSize: 12, fontWeight: active ? '600' : '400' }}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { alignSelf: 'center', width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingBottom: S.sm },
  controls: { alignSelf: 'center', width: '100%', maxWidth: MAX_W, flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: S.md, paddingTop: 4, paddingBottom: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, paddingVertical: 5, borderRadius: R.pill, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border2 },
  chipOn: { backgroundColor: 'rgba(124,156,255,.14)', borderColor: 'rgba(124,156,255,.4)' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: S.lg, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  icon: { width: 38, height: 38, borderRadius: R.md, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border2, alignItems: 'center', justifyContent: 'center' }
})
