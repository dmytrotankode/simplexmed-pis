/* eslint-disable import/first -- jest.mock має стояти до імпортів модулів, які він підміняє */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async (k: string) => (mockStore.has(k) ? mockStore.get(k)! : null)),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));

jest.mock('expo-crypto', () => {
  const nodeCrypto = jest.requireActual('crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: jest.fn(async (_alg: string, data: string) => nodeCrypto.createHash('sha256').update(data).digest('hex')),
    getRandomBytes: jest.fn((n: number) => new Uint8Array(nodeCrypto.randomBytes(n))),
  };
});

import * as SecureStore from 'expo-secure-store';

import { PIN_MAX_ATTEMPTS } from '../lib/config';
import { hasPin, hashPin, isValidPin, setPin, verifyPin } from '../lib/pin';
import { KEYS } from '../lib/secure';

beforeEach(() => mockStore.clear());

test('формат PIN: 4–6 цифр', () => {
  expect(isValidPin('1234')).toBe(true);
  expect(isValidPin('123456')).toBe(true);
  expect(isValidPin('123')).toBe(false);
  expect(isValidPin('12a4')).toBe(false);
  expect(isValidPin('1234567')).toBe(false);
});

test('зберігаються лише сіль і хеш у захищеному сховищі', async () => {
  await setPin('2580');
  const stored = mockStore.get(KEYS.pin)!;
  expect(stored).not.toContain('2580');
  const [salt, hash] = stored.split('$');
  expect(hash).toBe(await hashPin('2580', salt));
  expect(await hasPin()).toBe(true);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEYS.pin, stored, { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' });
});

test('однаковий PIN дає різні хеші (сіль)', async () => {
  await setPin('2580');
  const first = mockStore.get(KEYS.pin);
  await setPin('2580');
  expect(mockStore.get(KEYS.pin)).not.toBe(first);
});

test('правильний PIN розблоковує і скидає лічильник', async () => {
  await setPin('2580');
  expect((await verifyPin('0000')).attemptsLeft).toBe(PIN_MAX_ATTEMPTS - 1);
  const ok = await verifyPin('2580');
  expect(ok).toEqual({ ok: true, attemptsLeft: PIN_MAX_ATTEMPTS, wiped: false });
  expect(mockStore.has(KEYS.pinAttempts)).toBe(false);
});

test(`після ${PIN_MAX_ATTEMPTS} невдалих спроб дані стираються`, async () => {
  await setPin('2580');
  mockStore.set(KEYS.session, 'SESSION');
  let r = { ok: false, attemptsLeft: 0, wiped: false };
  for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) r = await verifyPin('1111');
  expect(r.wiped).toBe(true);
  expect(mockStore.has(KEYS.session)).toBe(false);
  expect(mockStore.has(KEYS.pin)).toBe(false);
});

test('некоректний PIN не зберігається', async () => {
  await expect(setPin('12')).rejects.toThrow('від 4 до 6 цифр');
});
