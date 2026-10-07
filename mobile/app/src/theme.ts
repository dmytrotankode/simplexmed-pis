import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

/**
 * Дизайн «Плексі» (напрям D): дві палітри — денна і нічна, вибір за системним налаштуванням телефона.
 *
 * Правило кольору: «дія» (accent) — лише кнопки, посилання й активна вкладка; «увага» (attention) — лише те,
 * що потребує дії Користувача (документи, адреса, верифікація, запит очікує підпису, помилки).
 * Решта — нейтральна; червоного на екранах немає (лише в системних діалогах підтвердження).
 */
export type Palette = {
  scheme: 'light' | 'dark';
  page: string;
  surface: string;
  ink: string;
  secondary: string;
  quiet: string;
  hairline: string;
  outline: string;
  accent: string;
  accentPressed: string;
  onAccent: string;
  accentTint: string;
  attention: string;
  attentionTint: string;
  attentionBorder: string;
  neutral: string;
  overlay: string;
  // Сумісні назви, якими користуються екрани
  primary: string;
  text: string;
  muted: string;
  border: string;
  bg: string;
  card: string;
  success: string;
  danger: string;
};

const BRAND_BLUE = '#273FCC';

export const lightPalette: Palette = {
  scheme: 'light',
  page: '#F3F5F8',
  surface: '#FFFFFF',
  ink: '#101828',
  secondary: '#475467',
  quiet: '#344054',
  hairline: '#E2E6EC',
  outline: '#667085',
  accent: BRAND_BLUE,
  accentPressed: '#1F33A6',
  onAccent: '#FFFFFF',
  accentTint: '#EBEEFB',
  attention: '#B54708',
  attentionTint: '#FFF6ED',
  attentionBorder: '#F9DBAF',
  neutral: '#F2F4F7',
  overlay: 'rgba(16,24,40,0.55)',
  primary: BRAND_BLUE,
  text: '#101828',
  muted: '#475467',
  border: '#667085',
  bg: '#F3F5F8',
  card: '#FFFFFF',
  success: '#101828',
  danger: '#B54708',
};

export const darkPalette: Palette = {
  scheme: 'dark',
  page: '#0C111D',
  surface: '#161B26',
  ink: '#F5F5F6',
  secondary: '#A4A7AE',
  quiet: '#CECFD2',
  hairline: '#333741',
  outline: '#85888E',
  accent: '#8EA2FF',
  accentPressed: '#B3C1FF',
  onAccent: '#0C111D',
  accentTint: '#1D2550',
  attention: '#FDB022',
  attentionTint: '#2A1C0A',
  attentionBorder: '#5C3A0E',
  neutral: '#1F242F',
  overlay: 'rgba(0,0,0,0.6)',
  primary: '#8EA2FF',
  text: '#F5F5F6',
  muted: '#A4A7AE',
  border: '#85888E',
  bg: '#0C111D',
  card: '#161B26',
  success: '#F5F5F6',
  danger: '#FDB022',
};

/** Шрифт Manrope (завантажується в кореневому макеті); до завантаження — системний. */
export const fonts = {
  regular: 'Manrope_500Medium',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
};

export function paletteFor(scheme: string | null | undefined): Palette {
  return scheme === 'dark' ? darkPalette : lightPalette;
}

/** Поточна палітра за системною темою (оновлюється, коли тема змінюється). */
export function useColors(): Palette {
  return paletteFor(useColorScheme());
}

/** Стилі, що залежать від палітри: const styles = useStyles(makeStyles). */
export function useStyles<T>(make: (c: Palette) => T): T {
  const colors = useColors();
  return useMemo(() => make(colors), [colors, make]);
}
