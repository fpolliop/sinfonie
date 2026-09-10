import React, { useEffect, useMemo, useState } from 'react'
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { DrawerNavigationProp } from '@react-navigation/drawer'
import { C, R, S, T } from '../theme'
import { Badge, EmptyState, Icon, IconButton } from '../ui'
import { refreshReviews, useStore } from '../store'
import { relativeTime } from '../util'
import type { DrawerParams } from '../App'
import type { RemoteReviewPr } from '../protocol'

const repoOf = (pr: RemoteReviewPr): string => pr.nameWithOwner.split('/').slice(-1)[0]

/** Pull requests waiting for your review, across your teams. Read-only: tap to open on GitHub. */
export function ReviewsScreen(): React.JSX.Element {
  const nav = useNavigation<DrawerNavigationProp<DrawerParams>>()
  const reviews = useStore((s) => s.reviews)
  const connected = useStore((s) => s.connected)
  const [loading, setLoading] = useState(reviews.length === 0)
  const [space, setSpace] = useState<string | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  useEffect(() => {
    refreshReviews()
    const t = setTimeout(() => setLoading(false), 10000)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    if (reviews.length) setLoading(false)
  }, [reviews])
  const refresh = (): void => {
    setLoading(true)
    refreshReviews()
    setTimeout(() => setLoading(false), 8000)
  }
  const spaces = useMemo(() => Array.from(new Map(reviews.filter((p) => p.space).map((p) => [p.space!.name, p.space!])).values()), [reviews])
  const repos = useMemo(() => Array.from(new Set(reviews.map(repoOf))).sort(), [reviews])
  const visible = useMemo(() => {
    let list = reviews
    if (space) list = list.filter((p) => p.space?.name === space)
    if (repo) list = list.filter((p) => repoOf(p) === repo)
    return list
  }, [reviews, space, repo])

  return (
    <View style={s.root}>
      <View style={s.header}>
        <IconButton name="menu-outline" onPress={() => nav.openDrawer()} />
        <Text style={[T.h1, { flex: 1 }]}>Reviews</Text>
        <Text style={T.small}>{reviews.length ? `${visible.length} of ${reviews.length}` : connected ? 'Live' : 'Offline'}</Text>
      </View>
      {spaces.length > 1 && (
        <View style={s.controls}>
          <Chip label="All spaces" active={space === null} onPress={() => setSpace(null)} />
          {spaces.map((sp) => (
            <Chip key={sp.name} label={sp.name} color={sp.color} active={space === sp.name} onPress={() => setSpace(space === sp.name ? null : sp.name)} />
          ))}
        </View>
      )}
      {repos.length > 1 && (
        <View style={[s.controls, spaces.length > 1 && { paddingTop: 0 }]}>
          <Chip label="All repos" active={repo === null} onPress={() => setRepo(null)} />
          {repos.map((rp) => (
            <Chip key={rp} label={rp} active={repo === rp} onPress={() => setRepo(repo === rp ? null : rp)} />
          ))}
        </View>
      )}
      <FlatList
        data={visible}
        keyExtractor={(p) => `${p.nameWithOwner}#${p.number}`}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={loading && reviews.length > 0} onRefresh={refresh} tintColor={C.muted} />}
        renderItem={({ item }) => <ReviewRow pr={item} />}
        ListEmptyComponent={
          loading ? (
            <EmptyState icon="cloud-download-outline" title="Looking for pull requests…" body="Gathering the PRs across your teams where you are asked to review." />
          ) : reviews.length > 0 ? (
            <EmptyState icon="filter-outline" title="Nothing matches" body="No pull requests match the filters above. Clear them to see the rest." />
          ) : (
            <EmptyState icon="checkmark-done-outline" title="Nothing to review" body="Pull requests that ask for your review across your teams show up here. Pull to refresh." />
          )
        }
      />
    </View>
  )
}

function ReviewRow({ pr }: { pr: RemoteReviewPr }): React.JSX.Element {
  return (
    <Pressable onPress={() => void Linking.openURL(pr.url)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.panel }]}>
      <View style={s.icon}>
        <Icon name="git-pull-request-outline" size={18} color={C.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[T.h2, { flex: 1, fontSize: 15 }]} numberOfLines={2}>
            {pr.title}
          </Text>
          {pr.isDraft && <Badge text="draft" tone="muted" />}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
          {pr.space && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pr.space.color }} />
              <Text style={{ color: C.dim, fontSize: 12 }}>{pr.space.name}</Text>
            </View>
          )}
          <Text style={{ color: C.muted, fontSize: 12 }}>
            {repoOf(pr)} #{pr.number}
          </Text>
          <Text style={{ color: C.dim, fontSize: 12 }}>by {pr.author}</Text>
          <Text style={{ color: C.dim, fontSize: 12 }}>· {relativeTime(pr.updatedAt)}</Text>
        </View>
      </View>
      <Icon name="open-outline" size={16} color={C.dim} />
    </Pressable>
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingBottom: S.sm },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: S.md, paddingTop: 4, paddingBottom: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, paddingVertical: 5, borderRadius: R.pill, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border2 },
  chipOn: { backgroundColor: 'rgba(124,156,255,.14)', borderColor: 'rgba(124,156,255,.4)' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: S.lg, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  icon: { width: 38, height: 38, borderRadius: R.md, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border2, alignItems: 'center', justifyContent: 'center' }
})
