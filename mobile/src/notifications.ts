/**
 * Push through Expo's push service: the relay posts to exp.host with this device's Expo token, so
 * no APNs or FCM credentials live on the relay. Permission pushes carry Allow / Deny actions that
 * answer without opening the app; the reply goes straight to the relay over HTTPS.
 */
import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { control, getState, registerNotifDismiss } from './store'
import { seal, sendUrl } from './protocol'

export const PERMISSION_CATEGORY = 'sinfonie.permission'

/** Remove delivered notifications for a workspace from the tray (it was opened on the Mac or here). */
export async function dismissForWorkspace(workspaceId: string): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync()
    await Promise.all(
      shown
        .filter((n) => ((n.request.content.data ?? {}) as { workspaceId?: string }).workspaceId === workspaceId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
    )
  } catch {
    /* best effort */
  }
}
/** Remove the delivered notification tied to a prompt that was just answered somewhere. */
export async function dismissForRequest(requestId: string): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync()
    await Promise.all(
      shown
        .filter((n) => ((n.request.content.data ?? {}) as { requestId?: string }).requestId === requestId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
    )
  } catch {
    /* best effort */
  }
}
// Let the store dismiss tray notifications when the Mac says a workspace was seen or a prompt resolved.
registerNotifDismiss(
  (workspaceId) => void dismissForWorkspace(workspaceId),
  (requestId) => void dismissForRequest(requestId)
)

const BANNER_DISMISSED_KEY = 'sinfonie.pushBannerDismissed'

/** Whether the OS has already granted notification permission to Sinfonie. */
export async function pushGranted(): Promise<boolean> {
  try {
    return (await Notifications.getPermissionsAsync()).status === 'granted'
  } catch {
    return false
  }
}
/** Whether the person has dismissed the "enable notifications" banner (persisted across launches). */
export async function bannerDismissed(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(BANNER_DISMISSED_KEY)) === '1'
  } catch {
    return false
  }
}
export async function dismissBanner(): Promise<void> {
  try {
    await SecureStore.setItemAsync(BANNER_DISMISSED_KEY, '1')
  } catch {
    /* best effort */
  }
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false })
})

export async function setupCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(PERMISSION_CATEGORY, [
    { identifier: 'allow', buttonTitle: 'Allow', options: { opensAppToForeground: false } },
    { identifier: 'deny', buttonTitle: 'Deny', options: { opensAppToForeground: false, isDestructive: true } }
  ])
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('prompts', { name: 'Agent prompts', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 200, 100, 200], lightColor: '#7c9cff' })
    await Notifications.setNotificationChannelAsync('activity', { name: 'Agent activity', importance: Notifications.AndroidImportance.DEFAULT })
  }
}

/** Asks for permission, fetches the Expo push token and registers it with the relay room. */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!Device.isDevice) return { ok: false, reason: 'Push needs a real device, not a simulator.' }
  const cur = await Notifications.getPermissionsAsync()
  let status = cur.status
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return { ok: false, reason: 'Notifications are not allowed for Sinfonie in the phone settings.' }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
  if (!projectId) return { ok: false, reason: 'This build has no EAS project id, so it cannot get a push token.' }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
  control({ ctl: 'push-subscribe', subscription: { expo: token } })
  return { ok: true }
}

/** Handles taps and the Allow / Deny actions. Returns the workspace to open, if any. */
export async function handleResponse(r: Notifications.NotificationResponse): Promise<string | null> {
  const data = (r.notification.request.content.data ?? {}) as { kind?: string; workspaceId?: string; requestId?: string }
  if ((r.actionIdentifier === 'allow' || r.actionIdentifier === 'deny') && data.requestId) {
    const p = getState().pairing
    if (p) await fetch(sendUrl(p), { method: 'POST', body: seal(p, { type: 'permission', requestId: data.requestId, decision: r.actionIdentifier }) }).catch(() => undefined)
    return null
  }
  return data.workspaceId ?? null
}
