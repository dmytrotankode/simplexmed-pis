import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import { ApiError, api } from './api';
import { AUTH_REDIRECT, EHEALTH_ENV } from './config';

/**
 * Вхід і реєстрація через сервіс авторизації ЕСОЗ (п.3.3, 3.5 ТВ ПІС) для мобільного застосунку.
 *
 * 1. Застосунок створює одноразовий code_verifier і передає BFF лише його SHA-256 (code_challenge);
 *    BFF формує URL сервісу авторизації і state, підписаний разом із challenge.
 * 2. Сторінка ЕСОЗ відкривається в системному браузері (Custom Tabs / ASWebAuthenticationSession).
 * 3. ЕСОЗ повертає на зареєстрований redirect_uri (simplex-med.com), redirect-ehealth.js — на
 *    https://my-dev.simplex-med.com/ehealth/return/app, а та сторінка — на simplexpis://auth/callback.
 * 4. Застосунок звіряє state і обмінює code разом із verifier на сесію кабінету (токени ЕСОЗ
 *    лишаються на сервері). Інший застосунок, що перехопив посилання, не знає verifier.
 */
export type Callback = { code?: string; state?: string; error?: string; errorDescription?: string };

export function parseCallback(url: string): Callback {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  const params = new URLSearchParams(query);
  return {
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    error: params.get('error') ?? undefined,
    errorDescription: params.get('error_description') ?? undefined,
  };
}

export class LoginCancelled extends Error {
  constructor() {
    super('Вхід скасовано');
    this.name = 'LoginCancelled';
  }
}

export async function getNonce(): Promise<string> {
  const r = await api<{ nonce: string }>('/auth/nonce', { method: 'POST' });
  return r.nonce;
}

/** Одноразова пара RFC 7636 (S256): verifier лишається в пам'яті, на сервер іде лише challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 });
  return { verifier, challenge: digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
}

/** Повертає токен сесії кабінету. userData — base64 підписаних КЕП даних (nonce або форма реєстрації). */
export async function loginWithEhealth({ userData, mode = 'sign-in' }: { userData?: string; mode?: 'sign-in' | 'sign-up' } = {}): Promise<string> {
  const pkce = await createPkce();
  const { url, state } = await api<{ url: string; state: string }>('/auth-url', {
    method: 'POST',
    body: { env: EHEALTH_ENV, mode, user_data: userData, code_challenge: pkce.challenge },
  });
  const result = await WebBrowser.openAuthSessionAsync(url, AUTH_REDIRECT);
  if (result.type !== 'success') throw new LoginCancelled();
  const cb = parseCallback(result.url);
  if (cb.error) {
    // п.3.5.6.1: помилки сервісу реєстрації — за рядками "PIS. Patient sign-up" Додатку 1
    const mapped = await api<{ error: string; next_step?: string | null }>('/auth/sign-in-error', {
      method: 'POST',
      body: { error: cb.error, error_description: cb.errorDescription ?? '', mode },
    });
    throw new ApiError(mapped.error, 400, { next_step: mapped.next_step ?? null });
  }
  if (!cb.code || cb.state !== state) {
    throw new ApiError('Сесія входу через ЕСОЗ застаріла. Почніть вхід ще раз.', 400);
  }
  const t = await api<{ session_token?: string }>('/auth/token', {
    method: 'POST',
    body: { code: cb.code, state, platform: 'MOBILE', code_verifier: pkce.verifier },
  });
  if (!t.session_token) throw new ApiError('Не вдалося завершити вхід. Спробуйте ще раз.', 500);
  return t.session_token;
}

export async function logoutOnServer(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await api('/auth/logout', { method: 'POST', token });   // п.3.7: припинення токенів ЕСОЗ і сесії
  } catch {
    // локальні дані все одно стираються
  }
}
