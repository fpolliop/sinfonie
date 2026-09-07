import React, { useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { Btn, Dot } from '../components'
import { C } from '../theme'
import { unpair, useStore } from '../store'
import { enablePush } from '../notifications'

export function SettingsScreen(): React.JSX.Element {
  const pairing = useStore((s) => s.pairing)
  const connected = useStore((s) => s.connected)
  const host = useStore((s) => s.host)
  const [pushMsg, setPushMsg] = useState<string | null>(null)
  return (
    <View style={s.root}>
      <View style={s.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Dot tone={connected ? 'on' : 'idle'} />
          <Text style={s.title}>{host || 'Paired Mac'}</Text>
        </View>
        <Text style={s.muted}>Relay {pairing?.relay.replace(/^https?:\/\//, '')} · room {pairing?.roomId.slice(0, 8)}…</Text>
        <Text style={[s.muted, { marginTop: 8 }]}>Everything between this phone and the Mac is encrypted with the key from the pairing code. Unpairing here forgets the key on this phone; unpairing on the Mac disconnects every phone.</Text>
        <Btn
          title="Unpair this phone"
          kind="danger"
          style={{ alignSelf: 'flex-start', marginTop: 12 }}
          onPress={() => Alert.alert('Unpair?', 'This phone will stop receiving anything from the Mac.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Unpair', style: 'destructive', onPress: () => void unpair() }])}
        />
      </View>
      <View style={s.card}>
        <Text style={s.title}>Notifications</Text>
        <Text style={s.muted}>Pushes arrive when the Mac has been idle for the time set in Settings → Phone on the Mac. Permission pushes can be answered from the notification.</Text>
        <Btn
          title="Re-register for push"
          style={{ alignSelf: 'flex-start', marginTop: 12 }}
          onPress={() => {
            void enablePush().then((r) => setPushMsg(r.ok ? 'Registered.' : r.reason ?? 'Failed.'))
          }}
        />
        {pushMsg && <Text style={[s.muted, { marginTop: 8 }]}>{pushMsg}</Text>}
      </View>
      <Text style={[s.muted, { textAlign: 'center', marginTop: 20 }]}>Sinfonie {Constants.expoConfig?.version}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 14, gap: 12 },
  card: { borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 14, backgroundColor: C.panel },
  title: { color: C.text, fontWeight: '700', fontSize: 15, marginBottom: 4 },
  muted: { color: C.muted, fontSize: 13, lineHeight: 18 }
})
