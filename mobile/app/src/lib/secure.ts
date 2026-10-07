import * as SecureStore from 'expo-secure-store';

/**
 * п.1.4.2 ТВ ПІС: токени й секрети — лише в захищеному сховищі (Android Keystore / iOS Keychain),
 * без резервного копіювання та без доступу, поки пристрій заблоковано.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const KEYS = {
  session: 'pis.session',
  pin: 'pis.pin',
  pinAttempts: 'pis.pin.attempts',
  biometric: 'pis.biometric',
  /** п.3.5.8.2: після реєстрації потрібно завантажити копії документів */
  documentsPending: 'pis.documents.pending',
} as const;

export function getSecure(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, OPTIONS);
}

export function setSecure(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value, OPTIONS);
}

export function deleteSecure(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key, OPTIONS);
}

export async function wipeAll(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((k) => deleteSecure(k)));
}
