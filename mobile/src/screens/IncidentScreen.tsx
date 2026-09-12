import React from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { C, MAX_W, R, S, T, pane } from '../theme'
import { Badge, Card, Icon, IconButton } from '../ui'
import { oncallApprove, oncallDismissProposal, oncallSetSeverity, oncallSetStatus, useStore } from '../store'
import { relativeTime } from '../util'
import type { RootStack } from '../App'
import type { IncidentStatus, RemoteIncident, Severity } from '../protocol'

const SEVS: Severity[] = ['low', 'medium', 'high', 'critical']
const STATUSES: { id: IncidentStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dismissed', label: 'Dismissed' }
]
const sevTone = (s?: Severity): 'danger' | 'warn' | 'accent' | 'muted' => (s === 'critical' ? 'danger' : s === 'high' ? 'warn' : s === 'medium' ? 'accent' : 'muted')

/** One incident: the triage, the proposed fix, drafted replies you can send, and the thread. */
export function IncidentScreen(): React.JSX.Element {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>()
  const { id } = useRoute<RouteProp<RootStack, 'Incident'>>().params
  const inc = useStore((s) => s.onCall.find((i) => i.id === id))
  if (!inc) {
    return (
      <View style={s.root}>
        <Header title="Incident" onBack={() => nav.goBack()} />
        <Text style={[T.small, { padding: S.lg }]}>This incident is no longer available. Pull to refresh the on-call list.</Text>
      </View>
    )
  }
  const r = inc.report
  const drafts = inc.proposals.filter((p) => p.status === 'proposed')
  return (
    <View style={s.root}>
      <Header title={`#${inc.channelName}`} onBack={() => nav.goBack()} right={inc.permalink ? <IconButton name="open-outline" onPress={() => void Linking.openURL(inc.permalink!)} /> : undefined} />
      <ScrollView style={pane}
        contentContainerStyle={{ padding: S.lg, paddingBottom: 40, gap: S.md }}>
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            {inc.severity ? <Badge text={inc.severity} tone={sevTone(inc.severity)} /> : <Badge text="untriaged" tone="muted" />}
            <Badge text={inc.status} tone={inc.status === 'resolved' ? 'ok' : inc.status === 'dismissed' ? 'muted' : 'accent'} />
            {inc.kind === 'alerts' ? <Badge text="alert" tone="muted" icon="pulse-outline" /> : <Badge text="support" tone="muted" icon="chatbubble-ellipses-outline" />}
            {inc.occurrences && inc.occurrences > 1 ? <Badge text={`×${inc.occurrences}`} tone="warn" /> : null}
          </View>
          <Text style={T.h1}>{inc.title}</Text>
          <Text style={[T.small, { marginTop: 4 }]}>
            {inc.space ? `${inc.space.name} · ` : ''}opened {relativeTime(inc.createdAt)}
            {inc.costUsd ? ` · $${inc.costUsd.toFixed(2)}` : ''}
          </Text>
        </View>

        <Section label="Status">
          <View style={s.chips}>
            {STATUSES.map((st) => (
              <Chip key={st.id} label={st.label} active={inc.status === st.id} onPress={() => oncallSetStatus(inc.id, st.id)} />
            ))}
          </View>
        </Section>
        <Section label="Severity">
          <View style={s.chips}>
            {SEVS.map((sv) => (
              <Chip key={sv} label={sv} active={inc.severity === sv} onPress={() => oncallSetSeverity(inc.id, sv)} />
            ))}
          </View>
        </Section>

        {r ? (
          <Card>
            <Text style={T.h2}>Triage</Text>
            <Text style={[T.body, { marginTop: 6 }]}>{r.summary}</Text>
            {r.likelyCause ? (
              <>
                <Text style={s.lbl}>Likely cause</Text>
                <Text style={T.body}>{r.likelyCause}</Text>
              </>
            ) : null}
            {r.evidence?.length ? (
              <>
                <Text style={s.lbl}>Evidence</Text>
                {r.evidence.map((e, i) => (
                  <Bullet key={i} text={e} />
                ))}
              </>
            ) : null}
            {r.nextSteps?.length ? (
              <>
                <Text style={s.lbl}>Next steps</Text>
                {r.nextSteps.map((e, i) => (
                  <Bullet key={i} text={e} />
                ))}
              </>
            ) : null}
            {r.customerReply ? (
              <>
                <Text style={s.lbl}>Suggested reply</Text>
                <Text style={[T.body, { color: C.muted, fontStyle: 'italic' }]}>{r.customerReply}</Text>
              </>
            ) : null}
          </Card>
        ) : (
          <Card>
            <Text style={T.small}>Not triaged yet. The Mac triages incidents automatically; pull the list to refresh.</Text>
          </Card>
        )}

        {r?.proposedFix || inc.fix ? (
          <Card>
            <Text style={T.h2}>Proposed fix</Text>
            {r?.proposedFix ? (
              <>
                <Text style={[T.small, { marginTop: 2 }]}>{r.proposedFix.repo}</Text>
                <Text style={[T.body, { marginTop: 6 }]}>{r.proposedFix.summary}</Text>
                {r.proposedFix.changes?.map((c, i) => (
                  <Bullet key={i} text={c} />
                ))}
                {r.proposedFix.risks ? (
                  <>
                    <Text style={s.lbl}>Risks</Text>
                    <Text style={[T.body, { color: C.muted }]}>{r.proposedFix.risks}</Text>
                  </>
                ) : null}
              </>
            ) : null}
            {inc.fix ? (
              <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Badge text={inc.fix.status} tone={inc.fix.status === 'done' ? 'ok' : inc.fix.status === 'failed' ? 'danger' : 'accent'} />
                {inc.fix.phase ? <Text style={T.small}>{inc.fix.phase}</Text> : null}
                {inc.fix.prUrl ? (
                  <Pressable onPress={() => void Linking.openURL(inc.fix!.prUrl!)} style={s.link} hitSlop={6}>
                    <Icon name="git-pull-request-outline" size={14} color={C.accent} />
                    <Text style={{ color: C.accent, fontSize: 13 }}>Open PR</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        {drafts.length > 0 && (
          <Section label="Drafted replies">
            {drafts.map((p) => (
              <Card key={p.id} style={{ marginBottom: 8 }}>
                <Text style={T.body}>{p.text}</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <Pressable onPress={() => oncallApprove(inc.id, p.id)} style={[s.action, { backgroundColor: C.accent2 }]}>
                    <Icon name="paper-plane-outline" size={14} color="#fff" />
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Send in thread</Text>
                  </Pressable>
                  <Pressable onPress={() => oncallDismissProposal(inc.id, p.id)} style={[s.action, { backgroundColor: C.panel2 }]}>
                    <Text style={{ color: C.muted, fontSize: 13 }}>Dismiss</Text>
                  </Pressable>
                </View>
              </Card>
            ))}
          </Section>
        )}

        {inc.messages.length > 0 && (
          <Section label="Thread">
            {inc.messages.map((m, i) => (
              <View key={i} style={s.msg}>
                <Text style={{ color: C.muted, fontSize: 12, fontWeight: '600', marginBottom: 2 }}>{m.user}</Text>
                <Text style={T.body}>{m.text}</Text>
              </View>
            ))}
          </Section>
        )}
      </ScrollView>
    </View>
  )
}

function Header({ title, onBack, right }: { title: string; onBack: () => void; right?: React.ReactNode }): React.JSX.Element {
  return (
    <View style={s.header}>
      <IconButton name="chevron-back" onPress={onBack} />
      <Text style={[T.h2, { flex: 1 }]} numberOfLines={1}>
        {title}
      </Text>
      {right}
    </View>
  )
}
function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View>
      <Text style={[T.caption, { marginBottom: 6 }]}>{label}</Text>
      {children}
    </View>
  )
}
function Bullet({ text }: { text: string }): React.JSX.Element {
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
      <Text style={{ color: C.dim }}>•</Text>
      <Text style={[T.body, { flex: 1 }]}>{text}</Text>
    </View>
  )
}
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={[s.chip, active && s.chipOn]} hitSlop={4}>
      <Text style={{ color: active ? C.accent : C.muted, fontSize: 12, fontWeight: active ? '600' : '400', textTransform: 'capitalize' }}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { alignSelf: 'center', width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingVertical: S.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: R.pill, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border2 },
  chipOn: { backgroundColor: 'rgba(124,156,255,.14)', borderColor: 'rgba(124,156,255,.4)' },
  lbl: { ...T.caption, marginTop: 12, marginBottom: 4 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: R.md },
  link: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  msg: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border }
})
