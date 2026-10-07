import * as LocalAuthentication from 'expo-local-authentication';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Alert, AppState, type AppStateStatus } from 'react-native';

import { ApiError } from './api';
import { logoutOnServer } from './auth';
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
  signOut: () => Promise<void>;
  /** Обробка помилки API: недійсна сесія — локальний вихід. */
  handleApiError: (e: unknown) => string;
};

const SessionContext = createContext<SessionValue | null>(null);
const TICK_MS = 15_000;

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
      const [stored, pin, bio] = await Promise.all([getSecure(KEYS.session), hasPin(), getSecure(KEYS.biometric)]);
      setToken(stored);
      setBiometricEnabled(bio === '1');
      setStatus(statusOnStart(Boolean(stored), pin));
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

  const wipeLocal = useCallback(async () => {
    await wipeAll();
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
      await logoutOnServer(token);
      await wipeLocal();
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
    await logoutOnServer(token);
    await wipeLocal();
  }, [token, wipeLocal]);

  const handleApiError = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      if (e.unauthorized) void wipeLocal();
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
    lock, signOut, handleApiError,
  }), [status, token, appState, biometricEnabled, touch, signIn, setupPin, unlockWithPin, unlockWithBiometric,
       lock, signOut, handleApiError]);

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
