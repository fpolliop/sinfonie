import React, { useEffect, useState } from 'react'
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { DrawerNavigationProp } from '@react-navigation/drawer'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { C, MAX_W, S, T } from '../theme'
import { Badge, IconButton, Row, SectionHeader } from '../ui'
import { unpair, useStore } from '../store'
import { enablePush } from '../notifications'
import type { DrawerParams } from '../App'

export function SettingsScreen(): React.JSX.Element {
  const nav = useNavigation<DrawerNavigationProp<DrawerParams>>()
  const pairing = useStore((s) => s.pairing)
  const connected = useStore((s) => s.connected)
  const host = useStore((s) => s.host)
  const [perm, setPerm] = useState<string>('…')
  const [pushMsg, setPushMsg] = useState<string | null>(null)
  useEffect(() => {
    void Notifications.getPermissionsAsync().then((p) => setPerm(p.status))
  }, [pushMsg])
  const version = Constants.expoConfig?.version ?? ''
  const build = Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? ''

  return (
    <View style={s.root}>
      <View style={s.header}>
        <IconButton name="menu-outline" onPress={() => nav.openDrawer()} />
        <Text style={[T.h1, { flex: 1 }]}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: S.md, paddingBottom: 40, width: '100%', maxWidth: MAX_W, alignSelf: 'center' }}>
        <SectionHeader title="Mac" />
        <View style={s.group}>
          <Row icon="laptop-outline" title={host || 'Paired Mac'} subtitle={connected ? 'Connected through the relay' : 'Reconnecting…'} right={<Badge text={connected ? 'online' : 'offline'} tone={connected ? 'ok' : 'danger'} />} first />
          <Row icon="key-outline" iconColor={C.violet} title="End-to-end encrypted" subtitle="The key from the pairing code never leaves this phone and the Mac. The relay forwards what it cannot read." />
          <Row icon="server-outline" iconColor={C.muted} title={pairing?.relay.replace(/^https?:\/\//, '') ?? ''} subtitle={`Room ${pairing?.roomId.slice(0, 12) ?? ''}…`} last />
        </View>

        <SectionHeader title="Notifications" />
        <View style={s.group}>
          <Row icon="notifications-outline" title="Push notifications" subtitle={perm === 'granted' ? 'Allowed on this phone' : perm === 'denied' ? 'Blocked in the phone settings' : 'Not enabled yet'} right={<Badge text={perm === 'granted' ? 'on' : 'off'} tone={perm === 'granted' ? 'ok' : 'muted'} />} first />
          <Row
            icon="refresh-outline"
            title="Register this phone for push"
            subtitle={pushMsg ?? 'Run this again if notifications stop arriving.'}
            onPress={() => void enablePush().then((r) => setPushMsg(r.ok ? 'Registered with the relay.' : r.reason ?? 'Failed.'))}
          />
          <Row icon="time-outline" iconColor={C.warn} title="When to notify" subtitle="Set on the Mac under Settings → Phone: how long the Mac must be idle, and which events to push." last />
        </View>

        <SectionHeader title="About" />
        <View style={s.group}>
          <Row icon="information-circle-outline" title="Sinfonie for iPhone and Android" subtitle={`Version ${version}${build ? ` (${build})` : ''}`} first />
          <Row icon="globe-outline" title="sinfonie.dev" onPress={() => void Linking.openURL('https://sinfonie.dev')} />
          <Row icon="help-buoy-outline" title="Help & feedback" onPress={() => void Linking.openURL('https://sinfonie.dev/support')} />
          <Row icon="document-text-outline" title="Privacy policy" onPress={() => void Linking.openURL('https://sinfonie.dev/privacy')} />
          <Row icon="reader-outline" title="Terms of service" onPress={() => void Linking.openURL('https://sinfonie.dev/terms')} last />
        </View>

        <SectionHeader title="Pairing" />
        <View style={s.group}>
          <Row
            icon="unlink-outline"
            iconColor={C.danger}
            title="Unpair this phone"
            subtitle="Forgets the key on this phone. The Mac keeps working with other phones."
            destructive
            first
            last
            onPress={() => Alert.alert('Unpair this phone?', 'It stops receiving anything from the Mac until you scan a new code.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Unpair', style: 'destructive', onPress: () => void unpair() }])}
          />
        </View>
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { alignSelf: 'center', width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: S.sm, paddingBottom: S.sm },
  group: { borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: C.border }
})
