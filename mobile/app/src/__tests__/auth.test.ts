/* eslint-disable import/first -- jest.mock має стояти до імпортів модулів, які він підміняє */
jest.mock('expo-constants', () => ({ expoConfig: { extra: { pisApiBase: 'https://pis.test', ehealthEnv: 'pis-app' } } }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('expo-crypto', () => {
  const nodeCrypto = jest.requireActual('crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    digestStringAsync: jest.fn(async (_alg: string, data: string, opts?: { encoding?: string }) =>
      nodeCrypto.createHash('sha256').update(data).digest(opts?.encoding === 'base64' ? 'base64' : 'hex')),
    getRandomBytes: jest.fn((n: number) => new Uint8Array(nodeCrypto.randomBytes(n))),
  };
});

import * as WebBrowser from 'expo-web-browser';

import { ApiError, api } from '../lib/api';
import { LoginCancelled, createPkce, loginWithEhealth, parseCallback } from '../lib/auth';
import { requestSignature, settleSignature, takePendingSignature } from '../lib/kepBridge';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let responses: { status: number; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 404, body: { error: 'not stubbed' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  });
});

const openAuth = WebBrowser.openAuthSessionAsync as jest.Mock;
const STATE = 'my-dev|/ehealth/return/app|123.abc.sig';
const nodeCrypto = jest.requireActual('crypto');
const s256 = (v: string) => nodeCrypto.createHash('sha256').update(v).digest('base64url');

test('createPkce: verifier за RFC 7636, challenge = BASE64URL(SHA256(verifier))', async () => {
  const a = await createPkce();
  const b = await createPkce();
  expect(a.verifier).toMatch(/^[0-9a-f]{64}$/);
  expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a.challenge).toBe(s256(a.verifier));
  expect(b.verifier).not.toBe(a.verifier);
});

test('parseCallback розбирає code/state/error', () => {
  expect(parseCallback('simplexpis://auth/callback?code=C1&state=pis-app%7C%2F%7Cn')).toEqual(
    { code: 'C1', state: 'pis-app|/|n', error: undefined, errorDescription: undefined });
  expect(parseCallback('simplexpis://auth/callback?error=access_denied&error_description=No').error).toBe('access_denied');
});

test('успішний вхід: state звірено, code обміняно на сесію кабінету', async () => {
  responses.push({ status: 200, body: { url: 'https://pis-auth.test/sign-in', state: STATE } });
  responses.push({ status: 200, body: { session_token: 'SESSION', ehealth_connected: true } });
  openAuth.mockResolvedValue({ type: 'success', url: `simplexpis://auth/callback?code=C1&state=${encodeURIComponent(STATE)}` });
  await expect(loginWithEhealth({ userData: 'U0lHTg==' })).resolves.toBe('SESSION');
  expect(calls[0].url).toBe('https://pis.test/api/auth-url');
  const authUrlBody = JSON.parse(String(calls[0].init.body));
  expect(authUrlBody).toEqual({ env: 'pis-app', mode: 'sign-in', user_data: 'U0lHTg==', code_challenge: expect.any(String) });
  expect(openAuth).toHaveBeenCalledWith('https://pis-auth.test/sign-in', 'simplexpis://auth/callback');
  const tokenBody = JSON.parse(String(calls[1].init.body));
  expect(tokenBody).toEqual({ code: 'C1', state: STATE, platform: 'MOBILE', code_verifier: expect.any(String) });
  // verifier не йде на сервер до обміну коду, а challenge відповідає саме йому
  expect(String(calls[0].init.body)).not.toContain(tokenBody.code_verifier);
  expect(authUrlBody.code_challenge).toBe(s256(tokenBody.code_verifier));
});

test('підмінений state відхиляється без обміну коду', async () => {
  responses.push({ status: 200, body: { url: 'https://pis-auth.test/sign-in', state: STATE } });
  openAuth.mockResolvedValue({ type: 'success', url: 'simplexpis://auth/callback?code=C1&state=my-dev%7C%2Fehealth%2Freturn%2Fapp%7Cother' });
  await expect(loginWithEhealth()).rejects.toThrow('застаріла');
  expect(calls).toHaveLength(1);
});

test('скасування в браузері', async () => {
  responses.push({ status: 200, body: { url: 'u', state: STATE } });
  openAuth.mockResolvedValue({ type: 'cancel' });
  await expect(loginWithEhealth()).rejects.toBeInstanceOf(LoginCancelled);
});

test('помилка сервісу авторизації — текст за Додатком 1 від сервера', async () => {
  responses.push({ status: 200, body: { url: 'u', state: STATE } });
  responses.push({ status: 200, body: { error: 'Користувача заблоковано' } });
  openAuth.mockResolvedValue({ type: 'success', url: 'simplexpis://auth/callback?error=invalid_request&error_description=User%20is%20blocked.' });
  await expect(loginWithEhealth()).rejects.toThrow('Користувача заблоковано');
  expect(calls[1].url).toBe('https://pis.test/api/auth/sign-in-error');
});

test('api: токен у заголовку, помилки з текстом сервера, ознаки 401', async () => {
  responses.push({ status: 401, body: { error: 'Увійдіть через ЕСОЗ', ehealth_required: true } });
  const err = await api('/ehealth/person', { token: 'T' }).catch((e) => e);
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer T');
  expect(err).toBeInstanceOf(ApiError);
  expect(err.message).toBe('Увійдіть через ЕСОЗ');
  expect(err.ehealthRequired).toBe(true);
  expect(err.unauthorized).toBe(false);
});

test('api: мережа недоступна', async () => {
  (global as any).fetch = jest.fn(async () => { throw new Error('offline'); });
  await expect(api('/x')).rejects.toThrow('Немає з’єднання');
});

test('міст підпису КЕП: запит, результат, скасування', async () => {
  const p = requestSignature('NONCE', 'Вхід', 'Підпишіть');
  expect(takePendingSignature()?.data).toBe('NONCE');
  settleSignature({ signed: 'SIGNED' });
  await expect(p).resolves.toBe('SIGNED');
  const q = requestSignature('N2', 't', 'p');
  settleSignature({});
  await expect(q).rejects.toThrow('Підпис скасовано');
  expect(takePendingSignature()).toBeNull();
});
