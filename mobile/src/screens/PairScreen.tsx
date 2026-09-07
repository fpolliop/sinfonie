import React, { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Btn } from '../components'
import { C } from '../theme'
import { parsePairingLink } from '../protocol'
import { savePairing } from '../store'

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
      <View style={s.body}>
        <Text style={s.h1}>Pair with your Mac</Text>
        <Text style={s.p}>In Sinfonie on the Mac, open Settings → Phone and press "Pair a phone". Scan the code it shows.</Text>
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
            <Btn title="Cancel" onPress={() => setScanning(false)} style={{ marginTop: 10, alignSelf: 'center' }} />
          </View>
        ) : (
          <Btn title="Scan the QR code" kind="primary" onPress={() => void startScan()} style={{ alignSelf: 'flex-start' }} />
        )}
        <Text style={[s.p, { marginTop: 22 }]}>Or paste the link from "Copy link instead":</Text>
        <TextInput value={link} onChangeText={setLink} placeholder="https://sinfonie.dev/m/#k=…" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} style={s.input} />
        <Btn title="Pair" onPress={() => void accept(link)} disabled={!link.trim() || busy} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        {error && <Text style={{ color: C.danger, marginTop: 12 }}>{error}</Text>}
        <Text style={[s.p, { marginTop: 28, fontSize: 12 }]}>The code holds the key that encrypts everything between this phone and the Mac. sinfonie.dev only relays; it cannot read your conversations.</Text>
      </View>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  body: { flex: 1, padding: 20 },
  h1: { color: C.text, fontSize: 22, fontWeight: '700', marginBottom: 8 },
  p: { color: C.muted, fontSize: 14, lineHeight: 20, marginBottom: 14 },
  camWrap: { alignItems: 'stretch' },
  cam: { height: 300, borderRadius: 14, overflow: 'hidden' },
  input: { borderWidth: 1, borderColor: C.border, backgroundColor: C.panel, color: C.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 }
})
