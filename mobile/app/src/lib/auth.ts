import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';

import { ApiError, api } from './api';
import { AUTH_REDIRECT, EHEALTH_ENV } from './config';
import { KEYS, deleteSecure, getSecure, setSecure } from './secure';

/**
 * Вхід і реєстрація через сервіс авторизації ЕСОЗ (п.3.3, 3.5 ТВ ПІС) для мобільного застосунку.
 *
 * 1. Застосунок створює одноразовий code_verifier і передає BFF лише його SHA-256 (code_challenge);
 *    BFF формує URL сервісу авторизації і state, підписаний разом із challenge.
 * 2. verifier, state і режим входу зберігаються в захищеному сховищі (10 хвилин): якщо ОС вивантажить
 *    застосунок, поки відкрито браузер, вхід завершиться після повторного запуску за посиланням.
 * 3. Сторінка ЕСОЗ відкривається в системному браузері (Custom Tabs / ASWebAuthenticationSession).
 * 4. ЕСОЗ повертає на зареєстрований redirect_uri, а сторінка BFF /ehealth/return/app сама обмінює код
 *    авторизації (у застосунок він не потрапляє) і відкриває simplexpis://auth/callback?handle=…&state=…
 *    (або ?error=expired_state&state=…).
 * 5. Застосунок звіряє state зі збереженим і забирає сесію кабінету: POST /auth/mobile/redeem
 *    {handle, state, code_verifier}. Інший застосунок, що перехопив посилання, не знає verifier.
 *    Помилки ЕСОЗ сервер уже перетворив на тексти Додатка 1 (з next_step: реєстрація, зміна даних).
 */

export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
/** Скільки посилання повернення лишається чинним (сервер видає handle на 3 хвилини). */
const CALLBACK_TTL_MS = 3 * 60 * 1000;
/** Android: застосунок стає активним трохи раніше, ніж приходить посилання повернення. */
export const LATE_CALLBACK_MS = 2000;

export const MSG_LOGIN_EXPIRED = 'Сесія входу через ЕСОЗ застаріла. Почніть вхід ще раз.';
export const MSG_BROWSER_UNAVAILABLE =
  'Не вдалося відкрити браузер для входу в ЕСОЗ. Встановіть або увімкніть браузер і спробуйте ще раз.';
export const MSG_LOGIN_FAILED = 'Не вдалося завершити вхід. Спробуйте ще раз.';

export type LoginMode = 'sign-in' | 'sign-up';
export type Callback = { handle?: string; state?: string; error?: string };
export type PendingLogin = {
  verifier: string;
  state: string;
  mode: LoginMode;
  createdAt: number;
  /** п.3.5.8.2: після реєстрації потрібні копії документів (щоб показати повідомлення і після перезапуску). */
  documentsPending?: boolean;
};
export type LoginResult = { token: string; mode: LoginMode; documentsPending: boolean };

export class LoginCancelled extends Error {
  constructor() {
    super('Вхід скасовано');
    this.name = 'LoginCancelled';
  }
}

// ---------------------------------------------------------------------------
// Посилання повернення simplexpis://auth/callback
// ---------------------------------------------------------------------------

/** Параметри рядка запиту (значення можуть містити «=»; некоректне кодування лишається як є). */
function queryParams(url: string): Record<string, string> {
  const q = url.indexOf('?');
  const query = q >= 0 ? url.slice(q + 1).split('#')[0] : '';
  const out: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    const key = decode(eq >= 0 ? pair.slice(0, eq) : pair);
    if (!(key in out)) out[key] = decode(eq >= 0 ? pair.slice(eq + 1) : '');
  }
  return out;
}

export function parseCallback(url: string): Callback {
  const p = queryParams(url);
  return { handle: p.handle || undefined, state: p.state || undefined, error: p.error || undefined };
}

/** Посилання повернення з ЕСОЗ (simplexpis://auth/callback[?…]) — не екран застосунку. */
export function isAuthCallbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = url.trim().toLowerCase();
  if (!lower.startsWith(AUTH_REDIRECT)) return false;
  const rest = lower.slice(AUTH_REDIRECT.length);
  return rest === '' || /^[/?#]/.test(rest);
}

let delivered: { url: string; at: number } | null = null;
let waiter: ((url: string) => void) | null = null;
const listeners = new Set<() => void>();
/** Оброблені посилання повернення: handle одноразовий, повторна спроба дала б хибну помилку. */
const processed = new Set<string>();
let activeLogins = 0;

/**
 * Посилання повернення, яке отримав застосунок поза сеансом браузера (src/app/+native-intent.tsx):
 * сеанс уже завершився як «закрито» (повернення через «Останні застосунки») або застосунок запущено заново.
 */
export function deliverAuthCallback(url: string, now = Date.now()): void {
  if (!isAuthCallbackUrl(url) || processed.has(url)) return;
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(url);
    return;
  }
  delivered = { url, at: now };
  if (activeLogins > 0) return;   // посилання забере вхід, що зараз триває
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // слухач екрана не повинен ламати обробку посилання
    }
  }
}

/** Підписка екрана входу на посилання повернення, що надійшло пізніше. */
export function onAuthCallback(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function takeDelivered(now = Date.now()): string | null {
  const d = delivered;
  delivered = null;
  return d && now - d.at <= CALLBACK_TTL_MS && !processed.has(d.url) ? d.url : null;
}

function waitForCallback(ms: number): Promise<string | null> {
  const ready = takeDelivered();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const done = (url: string) => {
      clearTimeout(timer);
      resolve(url);
    };
    const timer = setTimeout(() => {
      if (waiter === done) waiter = null;
      resolve(null);
    }, ms);
    waiter = done;
  });
}

/** Для тестів: скидання стану посилань у пам'яті. */
export function resetAuthCallbacks(): void {
  delivered = null;
  waiter = null;
  listeners.clear();
  processed.clear();
  activeLogins = 0;
}

// ---------------------------------------------------------------------------
// Незавершений вхід у захищеному сховищі
// ---------------------------------------------------------------------------

export function isPendingLoginFresh(p: PendingLogin, now = Date.now()): boolean {
  const age = now - p.createdAt;
  return age >= 0 && age < PENDING_LOGIN_TTL_MS;
}

export function parsePendingLogin(raw: string | null | undefined): PendingLogin | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingLogin>;
    if (typeof p.verifier !== 'string' || typeof p.state !== 'string' || typeof p.createdAt !== 'number'
        || (p.mode !== 'sign-in' && p.mode !== 'sign-up')) return null;
    return { verifier: p.verifier, state: p.state, mode: p.mode, createdAt: p.createdAt, documentsPending: p.documentsPending === true };
  } catch {
    return null;
  }
}

export async function savePendingLogin(p: PendingLogin): Promise<void> {
  await setSecure(KEYS.pendingLogin, JSON.stringify(p));
}

export async function clearPendingLogin(): Promise<void> {
  await deleteSecure(KEYS.pendingLogin).catch(() => {});
}

/** Збережений вхід, якщо він не старший за 10 хвилин (застарілий видаляється). */
export async function loadPendingLogin(now = Date.now()): Promise<PendingLogin | null> {
  let raw: string | null;
  try {
    raw = await getSecure(KEYS.pendingLogin);
  } catch {
    return null;
  }
  const p = parsePendingLogin(raw);
  if (p && isPendingLoginFresh(p, now)) return p;
  if (raw) await clearPendingLogin();
  return null;
}

// ---------------------------------------------------------------------------
// Вхід
// ---------------------------------------------------------------------------

export async function getNonce(): Promise<string> {
  const r = await api<{ nonce: string }>('/auth/nonce', { method: 'POST' });
  return r.nonce;
}

/** Одноразова пара RFC 7636 (S256): verifier лишається на пристрої, на сервер іде лише challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 });
  return { verifier, challenge: digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
}

/**
 * Посилання повернення для збереженого входу -> сесія кабінету. state має збігатися зі збереженим;
 * error=expired_state (сервер не знайшов вхід) — «сесія входу застаріла».
 */
export async function completeCallback(url: string, pending: PendingLogin | null): Promise<LoginResult> {
  const cb = parseCallback(url);
  if (!pending || !cb.state || cb.state !== pending.state) throw new ApiError(MSG_LOGIN_EXPIRED, 400);
  if (processed.has(url)) throw new ApiError(MSG_LOGIN_EXPIRED, 400);
  processed.add(url);
  await clearPendingLogin();
  if (cb.error || !cb.handle) throw new ApiError(MSG_LOGIN_EXPIRED, 400);
  // Помилки (зокрема next_step: реєстрація / зміна даних) — ApiError з текстом Додатка 1 від сервера
  const r = await api<{ session_token?: string }>('/auth/mobile/redeem', {
    method: 'POST',
    body: { handle: cb.handle, state: cb.state, code_verifier: pending.verifier },
  });
  if (!r.session_token) throw new ApiError(MSG_LOGIN_FAILED, 500);
  return { token: r.session_token, mode: pending.mode, documentsPending: Boolean(pending.documentsPending) };
}

/**
 * Вхід через ЕСОЗ. userData — base64 підписаних КЕП даних (nonce або форма реєстрації).
 * Браузер закрито без повернення — LoginCancelled (збережений вхід лишається: якщо посилання повернення
 * надійде пізніше, його завершить екран входу через resumePendingLogin).
 */
export async function loginWithEhealth({ userData, mode = 'sign-in', documentsPending = false }:
  { userData?: string; mode?: LoginMode; documentsPending?: boolean } = {}): Promise<LoginResult> {
  activeLogins += 1;
  try {
    const pkce = await createPkce();
    const { url, state } = await api<{ url?: string; state?: string }>('/auth-url', {
      method: 'POST',
      body: { env: EHEALTH_ENV, mode, user_data: userData, code_challenge: pkce.challenge },
    });
    if (!url || !state) throw new ApiError(MSG_LOGIN_FAILED, 500);
    const pending: PendingLogin = { verifier: pkce.verifier, state, mode, createdAt: Date.now() };
    if (documentsPending) pending.documentsPending = true;
    await savePendingLogin(pending);
    delivered = null;   // давні посилання не стосуються цього входу

    let result: WebBrowser.WebBrowserAuthSessionResult;
    try {
      result = await WebBrowser.openAuthSessionAsync(url, AUTH_REDIRECT);
    } catch {
      // Немає браузера з Custom Tabs (частина пристроїв Huawei) або браузер вимкнено
      await clearPendingLogin();
      throw new ApiError(MSG_BROWSER_UNAVAILABLE, 0, { browser_unavailable: true });
    }
    let callbackUrl: string | null = null;
    if (result.type === 'success') {
      callbackUrl = result.url;
      // те саме посилання могло надійти й через Linking (Android) — не обробляти вдруге
      // delivered змінює обробник Linking під час очікування — TS цього не бачить
      const late = delivered as { url: string } | null;
      if (late && late.url === callbackUrl) delivered = null;
    } else {
      callbackUrl = await waitForCallback(LATE_CALLBACK_MS);
    }
    if (!callbackUrl) throw new LoginCancelled();
    return await completeCallback(callbackUrl, pending);
  } finally {
    activeLogins -= 1;
  }
}

/**
 * Завершення входу, перерваного закриттям браузера або вивантаженням застосунку: посилання повернення
 * надійшло пізніше (deliverAuthCallback) або застосунок запущено ним (Linking.getInitialURL).
 * null — завершувати нічого.
 */
export async function resumePendingLogin({ initialUrl = () => Linking.getInitialURL() }:
  { initialUrl?: () => Promise<string | null> } = {}): Promise<LoginResult | null> {
  if (activeLogins > 0) return null;
  let url = takeDelivered();
  let fromLaunch = false;
  if (!url) {
    const launch = await initialUrl().catch(() => null);
    if (launch && isAuthCallbackUrl(launch) && !processed.has(launch)) {
      url = launch;
      fromLaunch = true;
    }
  }
  if (!url) return null;
  const pending = await loadPendingLogin();
  if (activeLogins > 0 || processed.has(url)) return null;
  const cb = parseCallback(url);
  if (!pending || cb.state !== pending.state) {
    processed.add(url);
    // Посилання запуску могло лишитися від давнього входу — тоді не показувати помилку
    if (fromLaunch) return null;
    throw new ApiError(MSG_LOGIN_EXPIRED, 400);
  }
  return completeCallback(url, pending);
}

/** п.3.7: припинення токенів ЕСОЗ і сесії. Повертає попередження за Додатком 1 (п.3.7.1.1), якщо ЕСОЗ відповіла помилкою. */
export async function logoutOnServer(token: string | null): Promise<string | null> {
  if (!token) return null;
  try {
    const r = await api<{ warning?: unknown }>('/auth/logout', { method: 'POST', token });
    return typeof r.warning === 'string' && r.warning.trim() ? r.warning : null;
  } catch {
    return null;   // локальні дані все одно стираються
  }
}

/**
 * Видалення облікового запису кабінету «Плексі» (вимоги App Store 5.1.1(v) і Google Play): обліковий запис
 * і сесії на всіх пристроях, токени ЕСОЗ відкликаються; записи в ЕСОЗ залишаються.
 */
export async function deleteAccountOnServer(token: string | null): Promise<string> {
  const r = await api<{ message?: unknown }>('/account', { method: 'DELETE', token, body: { confirm: 'DELETE' } });
  return typeof r.message === 'string' && r.message ? r.message : 'Обліковий запис видалено';
}
