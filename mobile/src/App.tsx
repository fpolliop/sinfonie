import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Linking from 'expo-linking'
import * as Notifications from 'expo-notifications'
import { DarkTheme, NavigationContainer, type NavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { C } from './theme'
import { connect, loadPairing, savePairing, useStore } from './store'
import { handleResponse, setupCategories } from './notifications'
import { parsePairingLink } from './protocol'
import { PairScreen } from './screens/PairScreen'
import { WorkspacesScreen } from './screens/WorkspacesScreen'
import { ChatScreen } from './screens/ChatScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export type RootStack = {
  Workspaces: undefined
  Chat: { workspaceId: string }
  Settings: undefined
}
const Stack = createNativeStackNavigator<RootStack>()
const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, text: C.text, border: C.border, primary: C.accent } }

export default function App(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const pairing = useStore((s) => s.pairing)
  const nav = useRef<NavigationContainerRef<RootStack>>(null)
  const pendingOpen = useRef<string | null>(null)

  useEffect(() => {
    void (async () => {
      await setupCategories().catch(() => undefined)
      let p = await loadPairing()
      // Development convenience: EXPO_PUBLIC_DEV_PAIR_LINK=<pairing link> pairs a fresh install without scanning.
      if (!p && __DEV__ && process.env.EXPO_PUBLIC_DEV_PAIR_LINK) {
        const dev = parsePairingLink(process.env.EXPO_PUBLIC_DEV_PAIR_LINK)
        if (dev) p = await savePairing(dev.k, dev.relay)
      }
      if (p) connect()
      // Opened from the pairing link (universal link / app link) or a notification.
      const initial = await Linking.getInitialURL()
      if (initial) await onLink(initial)
      const resp = await Notifications.getLastNotificationResponseAsync()
      if (resp) pendingOpen.current = await handleResponse(resp)
      setReady(true)
    })()
    const linkSub = Linking.addEventListener('url', (e) => void onLink(e.url))
    const notifSub = Notifications.addNotificationResponseReceivedListener((r) => {
      void handleResponse(r).then((wsId) => {
        if (wsId) openWorkspace(wsId)
      })
    })
    return () => {
      linkSub.remove()
      notifSub.remove()
    }
  }, [])

  const openWorkspace = (id: string): void => {
    if (nav.current?.isReady()) nav.current.navigate('Chat', { workspaceId: id })
    else pendingOpen.current = id
  }
  // Development: drive the app from the Hermes debugger (globalThis.__sinfonie.open(id), .back()).
  useEffect(() => {
    if (!__DEV__) return
    const g = globalThis as unknown as { __sinfonie?: Record<string, unknown> }
    g.__sinfonie = { ...(g.__sinfonie ?? {}), open: openWorkspace, back: () => nav.current?.goBack() }
  })
  async function onLink(url: string): Promise<void> {
    const parsed = parsePairingLink(url)
    if (parsed) await savePairing(parsed.k, parsed.relay)
  }

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.accent} />
      </View>
    )
  }
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {!pairing ? (
        <PairScreen />
      ) : (
        <NavigationContainer
          ref={nav}
          theme={theme}
          onReady={() => {
            if (pendingOpen.current) {
              nav.current?.navigate('Chat', { workspaceId: pendingOpen.current })
              pendingOpen.current = null
            }
          }}
        >
          <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text, headerTitleStyle: { fontWeight: '600' }, headerShadowVisible: false, contentStyle: { backgroundColor: C.bg } }}>
            <Stack.Screen name="Workspaces" component={WorkspacesScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      )}
    </SafeAreaProvider>
  )
}
