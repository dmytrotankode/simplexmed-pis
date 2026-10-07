import type { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, Text as RNText, type TextProps, ScrollView, StyleSheet, TextInput, type TextInputProps, View,
  type ViewStyle,
} from 'react-native';
import { SvgXml } from 'react-native-svg';

import { useTouch } from '../lib/session';
import { type Palette, fonts, useColors, useStyles } from '../theme';
import { Icon, type IconName } from './Icon';
import { LOGO_RATIO, logoFor } from './logoSvg';

export { useColors } from '../theme';
export type { Palette } from '../theme';

/** Назва продукту для Користувача; юридична назва ПІС — SimplexMed (документи, реєстрація в ЕСОЗ). */
export const BRAND_NAME = 'Плексі';

function familyFor(weight: unknown): string {
  const w = String(weight ?? '500');
  if (w === 'bold' || Number(w) >= 700) return fonts.bold;
  if (Number(w) >= 600) return fonts.semibold;
  return fonts.regular;
}

/** Текст дизайну «Плексі»: колір теми і накреслення Manrope за fontWeight (в т.ч. в нічній темі). */
export function Text({ style, ...props }: TextProps) {
  const colors = useColors();
  const flat = StyleSheet.flatten(style) ?? {};
  return <RNText {...props} style={[{ color: colors.ink, fontSize: 17 }, style, { fontFamily: familyFor(flat.fontWeight), fontWeight: 'normal' }]} />;
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.page, padding: 16 },
  screenBg: { flex: 1, backgroundColor: c.page },
  screenContent: { padding: 16, gap: 12, paddingBottom: 40 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700', color: c.ink, letterSpacing: -0.5 },
  muted: { fontSize: 15, lineHeight: 21, color: c.secondary },
  card: { backgroundColor: c.surface, borderRadius: 16, padding: 16, gap: 8 },
  cardWarning: { backgroundColor: c.attentionTint, borderWidth: 1, borderColor: c.attentionBorder },
  button: { minHeight: 56, borderRadius: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10 },
  buttonPrimary: { backgroundColor: c.accent },
  buttonSecondary: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.outline },
  buttonQuiet: { backgroundColor: 'transparent' },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.85 },
  buttonText: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: c.onAccent },
  buttonTextSecondary: { color: c.ink },
  buttonTextQuiet: { color: c.quiet },
  field: { gap: 6 },
  label: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: c.ink },
  input: { minHeight: 56, borderWidth: 1, borderColor: c.outline, borderRadius: 14, paddingHorizontal: 16, fontSize: 17, color: c.ink, backgroundColor: c.surface, fontFamily: fonts.regular },
  error: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', backgroundColor: c.attentionTint, borderColor: c.attentionBorder, borderWidth: 1, borderRadius: 14, padding: 14 },
  errorText: { flex: 1, color: c.attention, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, paddingVertical: 8 },
  rowLabel: { fontSize: 15, lineHeight: 21, color: c.secondary, flexShrink: 1 },
  rowValue: { fontSize: 17, lineHeight: 24, color: c.ink, fontWeight: '500', textAlign: 'right', flexShrink: 1 },
  section: { gap: 6 },
  sectionTitle: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: c.secondary, paddingHorizontal: 4 },
  group: { backgroundColor: c.surface, borderRadius: 16, overflow: 'hidden' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 },
  listRowBorder: { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: c.hairline },
  listIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  listTitle: { fontSize: 17, lineHeight: 24, fontWeight: '500' },
  listSubtitle: { fontSize: 15, lineHeight: 21, color: c.secondary },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 28, paddingLeft: 8, paddingRight: 10, borderRadius: 999 },
  pillText: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  tile: { flex: 1, minHeight: 104, padding: 16, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: c.hairline, backgroundColor: c.surface },
  tileIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
});

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const s = useStyles(makeStyles);
  if (!scroll) return <View style={s.screen}>{children}</View>;
  // Поле під клавіатурою прокручується у видиму частину (iOS), клавіатуру можна сховати жестом
  return (
    <ScrollView style={s.screenBg} contentContainerStyle={s.screenContent} keyboardShouldPersistTaps="handled"
                automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive">
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const s = useStyles(makeStyles);
  return <Text style={s.title} accessibilityRole="header">{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  const s = useStyles(makeStyles);
  return <Text style={s.muted}>{children}</Text>;
}

/** Картка; tone="warning" — «потребує уваги» (п. правила кольору), "success" — нейтральна. */
export function Card({ children, tone = 'default', style }: { children: ReactNode; tone?: 'default' | 'warning' | 'success'; style?: ViewStyle }) {
  const s = useStyles(makeStyles);
  return <View style={[s.card, tone === 'warning' && s.cardWarning, style]}>{children}</View>;
}

/**
 * Кнопки: primary/success — «дія» (колір акценту), secondary — контурна,
 * danger/quiet — тиха (незворотні дії підтверджує системний діалог).
 */
export function Button({ title, onPress, variant = 'primary', disabled, busy, accessibilityHint, icon }: {
  title: string; onPress: () => void; variant?: 'primary' | 'success' | 'secondary' | 'danger' | 'quiet';
  disabled?: boolean; busy?: boolean; accessibilityHint?: string; icon?: IconName;
}) {
  const s = useStyles(makeStyles);
  const colors = useColors();
  const inactive = disabled || busy;
  const solid = variant === 'primary' || variant === 'success';
  const quiet = variant === 'danger' || variant === 'quiet';
  const textColor = solid ? colors.onAccent : quiet ? colors.quiet : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [s.button, solid ? s.buttonPrimary : quiet ? s.buttonQuiet : s.buttonSecondary,
        inactive && s.buttonDisabled, pressed && s.buttonPressed]}
    >
      {busy ? <ActivityIndicator color={textColor} /> : (
        <>
          {icon ? <Icon name={icon} color={textColor} /> : null}
          <Text style={[s.buttonText, !solid && (quiet ? s.buttonTextQuiet : s.buttonTextSecondary)]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Field({ label, onChangeText, style, ...props }: TextInputProps & { label: string }) {
  const s = useStyles(makeStyles);
  const colors = useColors();
  const touch = useTouch();
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      {/* п.2.9: введення з клавіатури — теж дія користувача, скидає таймер бездіяльності */}
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.secondary} selectionColor={colors.accent}
                 keyboardAppearance={colors.scheme} style={[s.input, style]} {...props}
                 onChangeText={(text) => { touch(); onChangeText?.(text); }} />
    </View>
  );
}

/** Повідомлення про помилку — колір «увага» з іконкою (не лише колір). */
export function ErrorBox({ message }: { message?: string | null }) {
  const s = useStyles(makeStyles);
  const colors = useColors();
  if (!message) return null;
  return (
    <View style={s.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Icon name="alert" color={colors.attention} />
      <Text style={s.errorText}>{message}</Text>
    </View>
  );
}

export function Row({ label, value }: { label: string; value?: string | null }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.row} accessible accessibilityLabel={`${label}: ${value || 'не вказано'}`}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue} selectable>{value ? value : '—'}</Text>
    </View>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}

/** Біла група з рядками, розділеними тонкою лінією. */
export function Group({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const s = useStyles(makeStyles);
  return <View style={[s.group, style]}>{children}</View>;
}

export function ListRow({ title, subtitle, icon, onPress, first, tone = 'default', chevron = true, accessibilityHint }: {
  title: string; subtitle?: string | null; icon?: IconName; onPress?: () => void; first?: boolean;
  tone?: 'default' | 'action'; chevron?: boolean; accessibilityHint?: string;
}) {
  const s = useStyles(makeStyles);
  const colors = useColors();
  const content = (
    <>
      {icon ? <View style={s.listIcon}><Icon name={icon} color={colors.accent} /></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.listTitle, tone === 'action' && { color: colors.accent, fontWeight: '600' }]}>{title}</Text>
        {subtitle ? <Text style={s.listSubtitle}>{subtitle}</Text> : null}
      </View>
      {onPress && chevron ? <Icon name="chevron" color={colors.outline} /> : null}
    </>
  );
  if (!onPress) return <View style={[s.listRow, !first && s.listRowBorder]}>{content}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
               accessibilityHint={accessibilityHint}
               style={({ pressed }) => [s.listRow, !first && s.listRowBorder, pressed && { opacity: 0.7 }]}>
      {content}
    </Pressable>
  );
}

/** Статус: нейтральний (галочка/риска) або «увага» — завжди іконка + текст. */
export function StatusPill({ text, tone = 'neutral', icon }: { text: string; tone?: 'neutral' | 'attention' | 'ended'; icon?: IconName }) {
  const s = useStyles(makeStyles);
  const colors = useColors();
  const fg = tone === 'attention' ? colors.attention : tone === 'ended' ? colors.secondary : colors.ink;
  const bg = tone === 'attention' ? colors.attentionTint : colors.neutral;
  const glyph = icon ?? (tone === 'attention' ? 'alert' : tone === 'ended' ? 'stop' : 'check');
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      <Icon name={glyph} color={fg} size={16} strokeWidth={2.25} />
      <Text style={[s.pillText, { color: fg }]}>{text}</Text>
    </View>
  );
}

/** Велика плитка швидкої дії (головний екран). */
export function Tile({ title, icon, onPress }: { title: string; icon: IconName; onPress: () => void }) {
  const s = useStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}
               style={({ pressed }) => [s.tile, pressed && { opacity: 0.8 }]}>
      <View style={s.tileIcon}><Icon name={icon} color={colors.accent} /></View>
      <Text style={s.tileText}>{title}</Text>
    </Pressable>
  );
}

/** Логотип SimplexMed (світла/нічна версія). */
export function Logo({ width = 160 }: { width?: number }) {
  const colors = useColors();
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="Simplex Med">
      <SvgXml xml={logoFor(colors.scheme)} width={width} height={Math.round(width / LOGO_RATIO)} />
    </View>
  );
}

/** «Плексі» на базі SimplexMed. */
export function BrandLockup({ size = 'large' }: { size?: 'large' | 'small' }) {
  const colors = useColors();
  const large = size === 'large';
  return (
    <View style={{ gap: large ? 4 : 2 }} accessible accessibilityLabel={`${BRAND_NAME}, на базі Simplex Med`}>
      <Text style={large ? { fontSize: 48, lineHeight: 54, fontWeight: '700', letterSpacing: -1.5 }
                         : { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.5 }}>{BRAND_NAME}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ fontSize: large ? 15 : 13, lineHeight: large ? 21 : 18, color: colors.secondary }}>на базі</Text>
        <Logo width={large ? 86 : 64} />
      </View>
    </View>
  );
}

export function formatDate(value?: string | null): string {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value ?? '';
}
