import * as Crypto from 'expo-crypto';

import { PIN_MAX_ATTEMPTS, PIN_PATTERN } from './config';
import { KEYS, deleteSecure, getSecure, setSecure, wipeAll } from './secure';

/**
 * Локальний PIN-код застосунку (п.2.9 ТВ ПІС).
 * Зберігається лише сіль і багаторазовий SHA-256 у захищеному сховищі; після PIN_MAX_ATTEMPTS
 * невдалих спроб сесія і дані стираються — потрібен повторний вхід через ЕСОЗ.
 */
const ITERATIONS = 1000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin: string, salt: string, iterations = ITERATIONS): Promise<string> {
  let h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
  for (let i = 1; i < iterations; i++) {
    h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${h}:${salt}`);
  }
  return h;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export async function hasPin(): Promise<boolean> {
  return (await getSecure(KEYS.pin)) !== null;
}

export async function setPin(pin: string): Promise<void> {
  if (!isValidPin(pin)) throw new Error('PIN-код має містити від 4 до 6 цифр');
  const salt = toHex(Crypto.getRandomBytes(16));
  await setSecure(KEYS.pin, `${salt}$${await hashPin(pin, salt)}`);
  await deleteSecure(KEYS.pinAttempts);
}

export type PinCheck = { ok: boolean; attemptsLeft: number; wiped: boolean };

export async function verifyPin(pin: string): Promise<PinCheck> {
  const stored = await getSecure(KEYS.pin);
  if (!stored) return { ok: false, attemptsLeft: 0, wiped: true };
  const [salt, expected] = stored.split('$');
  if (constantTimeEqual(await hashPin(pin, salt), expected)) {
    await deleteSecure(KEYS.pinAttempts);
    return { ok: true, attemptsLeft: PIN_MAX_ATTEMPTS, wiped: false };
  }
  const failed = Number((await getSecure(KEYS.pinAttempts)) ?? '0') + 1;
  if (failed >= PIN_MAX_ATTEMPTS) {
    await wipeAll();
    return { ok: false, attemptsLeft: 0, wiped: true };
  }
  await setSecure(KEYS.pinAttempts, String(failed));
  return { ok: false, attemptsLeft: PIN_MAX_ATTEMPTS - failed, wiped: false };
}
