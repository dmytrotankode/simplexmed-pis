import Constants from 'expo-constants';

type Extra = { pisApiBase?: string; ehealthEnv?: string };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/** BFF кабінету пацієнта (той самий, що й для веб-кабінету). */
export const API_BASE = extra.pisApiBase ?? 'https://my-dev.simplex-med.com';
/** Середовище в state: redirect-ehealth.js повертає код на AUTH_REDIRECT. */
export const EHEALTH_ENV = extra.ehealthEnv ?? 'pis-app';
export const AUTH_REDIRECT = 'simplexpis://auth/callback';

/** п.2.9 ТВ ПІС: блокування після 5 хвилин без дій користувача. */
export const INACTIVITY_LOCK_MS = 5 * 60 * 1000;
export const PIN_MAX_ATTEMPTS = 5;
/** Лише для збірки, з якої знімають екрани для інструкції (EXPO_PUBLIC_ALLOW_SCREENSHOTS=1); звичайна збірка забороняє знімки. */
export const ALLOW_SCREENSHOTS = process.env.EXPO_PUBLIC_ALLOW_SCREENSHOTS === '1';
export const PIN_PATTERN = /^\d{4,6}$/;
