/** UI primitives: buttons, badges, cards, rows, empty states. Everything visual builds on these. */
import React from 'react'
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import * as Haptics from 'expo-haptics'
import { C, R, S, T, gradient } from './theme'

export type IoniconName = React.ComponentProps<typeof Ionicons>['name']

export function Icon({ name, size = 18, color = C.muted, style }: { name: IoniconName; size?: number; color?: string; style?: StyleProp<TextStyle> }): React.JSX.Element {
  return <Ionicons name={name} size={size} color={color} style={style} />
}

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'ok' | 'danger'
export function Button({ title, onPress, kind = 'secondary', icon, style, disabled, loading, small, haptic = true }: { title: string; onPress: () => void; kind?: BtnKind; icon?: IoniconName; style?: ViewStyle; disabled?: boolean; loading?: boolean; small?: boolean; haptic?: boolean }): React.JSX.Element {
  const fg = kind === 'primary' ? '#fff' : kind === 'ok' ? C.ok : kind === 'danger' ? C.danger : kind === 'ghost' ? C.muted : C.text
  const bg = kind === 'ok' ? 'rgba(74,222,128,.14)' : kind === 'danger' ? 'rgba(248,113,113,.14)' : kind === 'ghost' ? 'transparent' : C.panel2
  const border = kind === 'ok' ? 'rgba(74,222,128,.35)' : kind === 'danger' ? 'rgba(248,113,113,.35)' : kind === 'ghost' ? 'transparent' : C.border2
  const press = (): void => {
    if (haptic) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onPress()
  }
  const inner = (
    <>
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={small ? 14 : 16} color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: '600', fontSize: small ? 13 : 15 }}>{title}</Text>
    </>
  )
  if (kind === 'primary') {
    return (
      <Pressable onPress={press} disabled={disabled || loading} style={({ pressed }) => [{ opacity: disabled ? 0.5 : pressed ? 0.85 : 1, borderRadius: R.md }, style]}>
        <LinearGradient colors={[...gradient]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[s.btn, small && s.btnSmall]}>
          {inner}
        </LinearGradient>
      </Pressable>
    )
  }
  return (
    <Pressable onPress={press} disabled={disabled || loading} style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg, borderColor: border, borderWidth: 1, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }, style]}>
      {inner}
    </Pressable>
  )
}

export function IconButton({ name, onPress, color = C.text, size = 22, style, badge }: { name: IoniconName; onPress: () => void; color?: string; size?: number; style?: ViewStyle; badge?: number }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [s.iconBtn, pressed && { backgroundColor: C.panel2 }, style]}>
      <Icon name={name} size={size} color={color} />
      {badge ? (
        <View style={s.badgeDot}>
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{badge > 9 ? '9+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

export function Badge({ text, tone = 'muted', icon }: { text: string; tone?: 'muted' | 'warn' | 'accent' | 'ok' | 'danger'; icon?: IoniconName }): React.JSX.Element {
  const color = tone === 'warn' ? C.warn : tone === 'accent' ? C.accent : tone === 'ok' ? C.ok : tone === 'danger' ? C.danger : C.muted
  return (
    <View style={[s.badge, { borderColor: tone === 'muted' ? C.border2 : color + '66', backgroundColor: tone === 'muted' ? 'transparent' : color + '14' }]}>
      {icon && <Icon name={icon} size={11} color={color} />}
      <Text style={{ color, fontSize: 11, fontWeight: '600' }}>{text}</Text>
    </View>
  )
}

export function Dot({ tone, size = 8 }: { tone: 'idle' | 'busy' | 'need' | 'on' | 'off'; size?: number }): React.JSX.Element {
  const color = tone === 'busy' ? C.accent : tone === 'need' ? C.warn : tone === 'on' ? C.ok : tone === 'off' ? C.danger : C.dim
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, shadowColor: color, shadowOpacity: tone === 'idle' ? 0 : 0.8, shadowRadius: 6 }} />
}

export function Card({ children, style, tone }: { children: React.ReactNode; style?: ViewStyle; tone?: 'warn' }): React.JSX.Element {
  return <View style={[s.card, tone === 'warn' && { borderColor: 'rgba(251,191,36,.4)', backgroundColor: 'rgba(251,191,36,.05)' }, style]}>{children}</View>
}

export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }): React.JSX.Element {
  return (
    <View style={s.section}>
      <Text style={T.caption}>{title}</Text>
      {right}
    </View>
  )
}

export function Row({ icon, iconColor, title, subtitle, right, onPress, destructive, first, last }: { icon?: IoniconName; iconColor?: string; title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; destructive?: boolean; first?: boolean; last?: boolean }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.row, first && s.rowFirst, last && s.rowLast, pressed && onPress && { backgroundColor: C.panel2 }]}>
      {icon && (
        <View style={[s.rowIcon, { backgroundColor: (iconColor ?? C.accent) + '22' }]}>
          <Icon name={icon} size={16} color={iconColor ?? C.accent} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[T.body, destructive && { color: C.danger }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={T.small} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? (onPress ? <Icon name="chevron-forward" size={16} color={C.dim} /> : null)}
    </Pressable>
  )
}

export function EmptyState({ icon, title, body, action }: { icon: IoniconName; title: string; body?: string; action?: React.ReactNode }): React.JSX.Element {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={26} color={C.accent} />
      </View>
      <Text style={[T.h2, { marginTop: S.md, textAlign: 'center' }]}>{title}</Text>
      {body ? <Text style={[T.small, { textAlign: 'center', marginTop: 6, maxWidth: 300 }]}>{body}</Text> : null}
      {action ? <View style={{ marginTop: S.lg }}>{action}</View> : null}
    </View>
  )
}

export function Brand({ size = 28, wordmark = true }: { size?: number; wordmark?: boolean }): React.JSX.Element {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <Image source={require('../assets/mark.png')} style={{ width: size * 1.2, height: size * 1.2 }} resizeMode="contain" />
      </View>
      {wordmark && <Text style={{ color: C.text, fontSize: size * 0.68, fontWeight: '700', letterSpacing: -0.4 }}>Sinfonie</Text>}
    </View>
  )
}

export function SpaceChip({ name, color, small }: { name: string; color: string; small?: boolean }): React.JSX.Element {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: small ? 6 : 8, height: small ? 6 : 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: C.muted, fontSize: small ? 11 : 12, fontWeight: '500' }}>{name}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 16, paddingVertical: 11, borderRadius: R.md },
  btnSmall: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: R.sm + 2 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  badgeDot: { position: 'absolute', top: 3, right: 1, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, backgroundColor: C.warn, alignItems: 'center', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 2 },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: R.lg, padding: S.lg },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.lg, paddingTop: S.xl, paddingBottom: S.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: S.lg, paddingVertical: 12, backgroundColor: C.panel, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border2 },
  rowFirst: { borderTopLeftRadius: R.lg, borderTopRightRadius: R.lg },
  rowLast: { borderBottomLeftRadius: R.lg, borderBottomRightRadius: R.lg, borderBottomWidth: 0 },
  rowIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyIcon: { width: 60, height: 60, borderRadius: 20, backgroundColor: 'rgba(124,156,255,.12)', alignItems: 'center', justifyContent: 'center' }
})
