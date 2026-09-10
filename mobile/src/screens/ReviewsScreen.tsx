import React, { useEffect, useState } from 'react'
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { DrawerNavigationProp } from '@react-navigation/drawer'
import { C, R, S, T } from '../theme'
import { Badge, EmptyState, Icon, IconButton } from '../ui'
import { refreshReviews, useStore } from '../store'
import { relativeTime } from '../util'
import type { DrawerParams } from '../App'
import type { RemoteReviewPr } from '../protocol'

/** Pull requests waiting for your review, across your teams. Read-only: tap to open on GitHub. */
export function ReviewsScreen(): React.JSX.Element {
  const nav = useNavigation<DrawerNavigationProp<DrawerParams>>()
  const reviews = useStore((s) => s.reviews)
  const connected = useStore((s) => s.connected)
  const [loading, setLoading] = useState(reviews.length === 0)
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
  return (
    <View style={s.root}>
      <View style={s.header}>
        <IconButton name="menu-outline" onPress={() => nav.openDrawer()} />
        <Text style={[T.h1, { flex: 1 }]}>Reviews</Text>
        <Text style={T.small}>{reviews.length ? `${reviews.length} waiting` : connected ? 'Live' : 'Offline'}</Text>
      </View>
      <FlatList
        data={reviews}
        keyExtractor={(p) => `${p.nameWithOwner}#${p.number}`}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={loading && reviews.length > 0} onRefresh={refresh} tintColor={C.muted} />}
        renderItem={({ item }) => <ReviewRow pr={item} />}
        ListEmptyComponent={
          loading ? (
            <EmptyState icon="cloud-download-outline" title="Looking for pull requests…" body="Gathering the PRs across your teams where you are asked to review." />
          ) : (
            <EmptyState icon="checkmark-done-outline" title="Nothing to review" body="Pull requests that ask for your review across your teams show up here. Pull to refresh." />
          )
        }
      />
    </View>
  )
}

function ReviewRow({ pr }: { pr: RemoteReviewPr }): React.JSX.Element {
  const repo = pr.nameWithOwner.split('/').slice(-1)[0]
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
          <Text style={{ color: C.muted, fontSize: 12 }}>
            {repo} #{pr.number}
          </Text>
          <Text style={{ color: C.dim, fontSize: 12 }}>by {pr.author}</Text>
          <Text style={{ color: C.dim, fontSize: 12 }}>· {relativeTime(pr.updatedAt)}</Text>
        </View>
      </View>
      <Icon name="open-outline" size={16} color={C.dim} />
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingBottom: S.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: S.lg, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  icon: { width: 38, height: 38, borderRadius: R.md, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border2, alignItems: 'center', justifyContent: 'center' }
})
