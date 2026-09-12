import React, { useState } from 'react'
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { LinearGradient } from 'expo-linear-gradient'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, Icon, type IoniconName } from '../ui'
import { C, MAX_W, R, S, T, brandGradient, pane } from '../theme'
import { parsePairingLink } from '../protocol'
import { savePairing } from '../store'

function Step({ n, icon, text }: { n: number; icon: IoniconName; text: string }): React.JSX.Element {
  return (
    <View style={s.step}>
      <View style={s.stepIcon}>
        <Icon name={icon} size={16} color={C.accent} />
      </View>
      <Text style={[T.body, { flex: 1, color: C.muted }]}>
        <Text style={{ color: C.text, fontWeight: '600' }}>{n}. </Text>
        {text}
      </Text>
    </View>
  )
}

/** First screen until paired: scan the QR from Settings → Phone on the Mac, or paste the link. */
export function PairScreen(): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions()
  const [scanning, setScanning] = useState(false)
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const accept = async (text: string): Promise<void> => {
    if (busy) return
    const parsed = parsePairingLink(text)
    if (!parsed) {
      setError('That is not a Sinfonie pairing code.')
      return
    }
    setBusy(true)
    try {
      await savePairing(parsed.k, parsed.relay)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  const startScan = async (): Promise<void> => {
    if (!permission?.granted) {
      const r = await requestPermission()
      if (!r.granted) {
        setError('Camera access is needed to scan the code. You can paste the link instead.')
        return
      }
    }
    setError(null)
    setScanning(true)
  }

  return (
    <SafeAreaView style={s.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={pane} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <View style={s.hero}>
            <LinearGradient colors={[...brandGradient]} start={{ x: 0, y: 1 }} end={{ x: 1, y: 0 }} style={s.heroGlow} />
            <Image source={require('../../assets/mark.png')} style={{ width: 96, height: 96 }} resizeMode="contain" />
            <Text style={[T.title, { marginTop: 4 }]}>Sinfonie</Text>
            <Text style={[T.small, { textAlign: 'center', marginTop: 4, maxWidth: 300 }]}>Your agents on the Mac, in your pocket. Follow their work, answer when they ask, keep the conversation going.</Text>
          </View>

          {scanning ? (
            <View style={s.camWrap}>
              <CameraView
                style={s.cam}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(r) => {
                  if (busy) return
                  setScanning(false)
                  void accept(r.data)
                }}
              />
              <View style={s.camFrame} pointerEvents="none" />
              <Button title="Cancel" kind="ghost" onPress={() => setScanning(false)} style={{ marginTop: 10, alignSelf: 'center' }} />
            </View>
          ) : (
            <View style={s.card}>
              <Step n={1} icon="laptop-outline" text="On the Mac, open Sinfonie → Settings → Phone and press Pair a phone." />
              <Step n={2} icon="qr-code-outline" text="Scan the code it shows." />
              <Step n={3} icon="notifications-outline" text="Allow notifications so the agents can reach you." />
              <Button title="Scan the QR code" kind="primary" icon="scan-outline" onPress={() => void startScan()} loading={busy} style={{ marginTop: S.sm }} />
            </View>
          )}

          <Text style={[T.caption, { marginTop: S.xl, marginBottom: S.sm, paddingHorizontal: 4 }]}>Or paste the link</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput value={link} onChangeText={setLink} placeholder="https://sinfonie.dev/m/#k=…" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} style={s.input} />
            <Button title="Pair" onPress={() => void accept(link)} disabled={!link.trim() || busy} />
          </View>
          {error && (
            <View style={s.error}>
              <Icon name="alert-circle-outline" size={14} color={C.danger} />
              <Text style={{ color: C.danger, fontSize: 13, flex: 1 }}>{error}</Text>
            </View>
          )}
          <View style={s.privacy}>
            <Icon name="lock-closed-outline" size={13} color={C.dim} />
            <Text style={[T.small, { flex: 1, fontSize: 12 }]}>The code holds the key that encrypts everything between this phone and your Mac. sinfonie.dev only relays and cannot read your conversations.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  body: { padding: S.lg, paddingBottom: 40 },
  hero: { alignItems: 'center', paddingVertical: S.xl, overflow: 'visible' },
  heroGlow: { position: 'absolute', top: 10, width: 140, height: 140, borderRadius: 70, opacity: 0.18, transform: [{ scale: 1.6 }] },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: R.xl, padding: S.lg, gap: 12 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(124,156,255,.14)', alignItems: 'center', justifyContent: 'center' },
  camWrap: { alignItems: 'stretch' },
  cam: { height: 320, borderRadius: R.xl, overflow: 'hidden' },
  camFrame: { position: 'absolute', top: 60, alignSelf: 'center', width: 200, height: 200, borderRadius: 18, borderWidth: 2, borderColor: 'rgba(255,255,255,.7)' },
  input: { flex: 1, borderWidth: 1, borderColor: C.border2, backgroundColor: C.panel, color: C.text, borderRadius: R.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: S.md, padding: 10, borderRadius: R.md, backgroundColor: 'rgba(248,113,113,.1)' },
  privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: S.xl, paddingHorizontal: 4 }
})
