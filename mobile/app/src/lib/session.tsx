import * as LocalAuthentication from 'expo-local-authentication';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Alert, AppState, type AppStateStatus } from 'react-native';

import { ApiError } from './api';
import { deleteAccountOnServer, logoutOnServer } from './auth';
import { clearCacheDirectory, ensureFreshInstall } from './localFiles';
import { type SessionStatus, statusOnResume, statusOnStart, statusOnTick } from './lock';
import { type PinCheck, hasPin, setPin, verifyPin } from './pin';
import { KEYS, getSecure, setSecure, wipeAll } from './secure';

type SessionValue = {
  status: SessionStatus;
  token: string | null;
  appState: AppStateStatus;
  biometricEnabled: boolean;
  /** Зареєструвати дію користувача (скидає таймер бездіяльності). */
  touch: () => void;
  signIn: (token: string) => Promise<void>;
  setupPin: (pin: string, useBiometric: boolean) => Promise<void>;
  unlockWithPin: (pin: string) => Promise<PinCheck>;
  unlockWithBiometric: () => Promise<boolean>;
  lock: () => void;
  /** Вихід (п.3.7). Не кидає помилок; повертає попередження за Додатком 1, якщо ЕСОЗ не припинила токени (п.3.7.1.1). */
  signOut: () => Promise<string | null>;
  /** Видалення облікового запису «Плексі» на сервері і всіх даних на пристрої; повертає повідомлення сервера. */
  deleteAccount: () => Promise<string>;
  /** Обробка помилки API: недійсна сесія — локальний вихід. */
  handleApiError: (e: unknown) => string;
};

const SessionContext = createContext<SessionValue | null>(null);
const TICK_MS = 15_000;

/** п.2.9: після PIN_MAX_ATTEMPTS невдалих спроб дані застосунку на пристрої стираються. */
export const MSG_PIN_WIPED =
  'Після 5 невдалих спроб введення PIN-коду дані кабінету на цьому пристрої видалено. Увійдіть через ЕСОЗ знову.';

/** п.3.7.1.1: помилку ЕСОЗ під час виходу (текст за Додатком 1) показати Користувачу. */
export function showLogoutWarning(warning: string | null | undefined): void {
  if (warning) Alert.alert('Вихід з кабінету', warning);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const lastActivity = useRef(0);

  const touch = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  // Холодний старт завжди вимагає PIN/біометрію (п.2.9)
  useEffect(() => {
    lastActivity.current = Date.now();
    (async () => {
      try {
        // iOS зберігає Keychain після видалення застосунку: перший запуск після встановлення — з чистого сховища
        await ensureFreshInstall(wipeAll);
        const [stored, pin, bio] = await Promise.all([getSecure(KEYS.session), hasPin(), getSecure(KEYS.biometric)]);
        setToken(stored);
        setBiometricEnabled(bio === '1');
        setStatus(statusOnStart(Boolean(stored), pin));
      } catch {
        // Сховище ключів недоступне або пошкоджене (напр., після зміни блокування екрана пристрою):
        // локальний вихід — потрібен новий вхід через ЕСОЗ, а не «вічне» завантаження
        await wipeAll().catch(() => {});
        clearCacheDirectory();
        setToken(null);
        setBiometricEnabled(false);
        setStatus('signedOut');
      }
    })();
  }, []);

  // Повернення з фону після 5 хвилин без дій — блокування
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setAppState(next);
      if (next === 'active') setStatus((s) => statusOnResume(s, lastActivity.current, Date.now()));
    });
    return () => sub.remove();
  }, []);

  // Бездіяльність на відкритому екрані
  useEffect(() => {
    const id = setInterval(() => setStatus((s) => statusOnTick(s, lastActivity.current, Date.now())), TICK_MS);
    return () => clearInterval(id);
  }, []);

  /** Стирання всіх даних на пристрої: захищене сховище і кеш (експортовані форми, копії документів). */
  const wipeLocal = useCallback(async () => {
    try {
      await wipeAll();
    } catch {
      // сховище недоступне — стан застосунку все одно скидається
    }
    clearCacheDirectory();
    setToken(null);
    setBiometricEnabled(false);
    setStatus('signedOut');
  }, []);

  const signIn = useCallback(async (newToken: string) => {
    await setSecure(KEYS.session, newToken);
    setToken(newToken);
    touch();
    // п.2.9: після першої авторизації — обов'язкове встановлення PIN-коду
    setStatus((await hasPin()) ? 'unlocked' : 'needsPin');
  }, [touch]);

  const setupPin = useCallback(async (pin: string, useBiometric: boolean) => {
    await setPin(pin);
    await setSecure(KEYS.biometric, useBiometric ? '1' : '0');
    setBiometricEnabled(useBiometric);
    touch();
    setStatus('unlocked');
  }, [touch]);

  const unlockWithPin = useCallback(async (pin: string) => {
    const result = await verifyPin(pin);
    if (result.ok) {
      touch();
      setStatus('unlocked');
    } else if (result.wiped) {
      const warning = await logoutOnServer(token);
      await wipeLocal();
      Alert.alert('Кабінет заблоковано', warning ? `${MSG_PIN_WIPED}\n\n${warning}` : MSG_PIN_WIPED);
    }
    return result;
  }, [token, touch, wipeLocal]);

  const unlockWithBiometric = useCallback(async () => {
    if (!biometricEnabled) return false;
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Розблокування кабінету пацієнта',
      cancelLabel: 'Ввести PIN-код',
      disableDeviceFallback: true,
    });
    if (r.success) {
      touch();
      setStatus('unlocked');
    }
    return r.success;
  }, [biometricEnabled, touch]);

  const lock = useCallback(() => setStatus((s) => (s === 'unlocked' ? 'locked' : s)), []);

  const signOut = useCallback(async () => {
    const warning = await logoutOnServer(token);
    await wipeLocal();
    return warning;
  }, [token, wipeLocal]);

  const deleteAccount = useCallback(async () => {
    const message = await deleteAccountOnServer(token);
    await wipeLocal();
    return message;
  }, [token, wipeLocal]);

  const handleApiError = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      if (e.unauthorized) void wipeLocal().catch(() => {});
      // Додаток 1 «Дії ПІС»: пацієнт не верифікований — запропонувати перейти до оновлення даних
      if (e.nextStep === 'person-edit') {
        Alert.alert('Потрібно оновити дані', e.message, [
          { text: 'Не зараз', style: 'cancel' },
          { text: 'Змінити дані', onPress: () => router.push('/person-edit') },
        ]);
      }
      return e.message;
    }
    return e instanceof Error ? e.message : 'Сталася помилка';
  }, [wipeLocal]);

  const value = useMemo<SessionValue>(() => ({
    status, token, appState, biometricEnabled, touch, signIn, setupPin, unlockWithPin, unlockWithBiometric,
    lock, signOut, deleteAccount, handleApiError,
  }), [status, token, appState, biometricEnabled, touch, signIn, setupPin, unlockWithPin, unlockWithBiometric,
       lock, signOut, deleteAccount, handleApiError]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

const noop = () => {};

/** Дія користувача для таймера бездіяльності (п.2.9); поза SessionProvider нічого не робить. */
export function useTouch(): () => void {
  return useContext(SessionContext)?.touch ?? noop;
}
