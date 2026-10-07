import { INACTIVITY_LOCK_MS } from './config';

/**
 * Правила блокування застосунку PIN-кодом або біометрією (п.2.9 ТВ ПІС).
 * Чисті функції — стан і час передаються ззовні, тож логіку легко тестувати.
 *
 * Вимагати PIN/біометрію, якщо:
 *  - користувач не взаємодіяв із застосунком 5 хвилин (зокрема поки застосунок у фоні);
 *  - застосунок завершив роботу (холодний старт: закриття, вивантаження ОС, перезапуск, збій);
 *  - користувач вийшов із сесії (тоді потрібен і повторний вхід через ЕСОЗ).
 */
export type SessionStatus = 'loading' | 'signedOut' | 'needsPin' | 'locked' | 'unlocked';

export function isInactive(lastActivityAt: number, now: number, limitMs = INACTIVITY_LOCK_MS): boolean {
  return now - lastActivityAt >= limitMs;
}

/** Стан під час запуску застосунку (холодний старт завжди блокує). */
export function statusOnStart(hasSession: boolean, hasPin: boolean): SessionStatus {
  if (!hasSession) return 'signedOut';
  return hasPin ? 'locked' : 'needsPin';
}

/** Після повернення з фону: блокувати, якщо без дій минуло 5 хвилин. */
export function statusOnResume(current: SessionStatus, lastActivityAt: number, now: number): SessionStatus {
  if (current === 'unlocked' && isInactive(lastActivityAt, now)) return 'locked';
  return current;
}

/** Періодична перевірка бездіяльності на активному екрані. */
export function statusOnTick(current: SessionStatus, lastActivityAt: number, now: number): SessionStatus {
  return statusOnResume(current, lastActivityAt, now);
}

/** Чи приховувати вміст (перемикач застосунків, неактивний стан, блокування). */
export function shouldCoverContent(appState: string, status: SessionStatus): boolean {
  return status === 'locked' || (status === 'unlocked' && appState !== 'active');
}

/**
 * Чи можна показувати модальне вікно (окреме нативне вікно над усім, зокрема над екраном PIN-коду):
 * лише в розблокованому кабінеті. До входу (форма реєстрації) PIN-коду ще немає — дозволено, якщо
 * екран працює без сесії (allowSignedOut).
 */
export function isModalAllowed(status: SessionStatus, allowSignedOut = false): boolean {
  return status === 'unlocked' || (allowSignedOut && status === 'signedOut');
}
