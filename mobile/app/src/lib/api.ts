import { API_BASE } from './config';

/** Помилка BFF: message — текст для користувача (повідомлення за Додатком 1 ТВ ПІС, якщо його сформував сервер). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Сесія кабінету недійсна — потрібен новий вхід. */
  get unauthorized(): boolean {
    return this.status === 401 && !this.body.ehealth_required;
  }

  /** Дія ПІС за Додатком 1, яку підказує сервер: перейти до зміни даних або до реєстрації. */
  get nextStep(): 'person-edit' | 'sign-up' | null {
    const step = this.body.next_step;
    return step === 'person-edit' || step === 'sign-up' ? step : null;
  }

  /** Сесія є, але доступ до ЕСОЗ у ній припинено — потрібен повторний вхід через ЕСОЗ. */
  get ehealthRequired(): boolean {
    return this.status === 401 && Boolean(this.body.ehealth_required);
  }
}

/**
 * Скільки чекати відповіді BFF. Сервер чекає ЕСОЗ до 60 с, тож застосунок чекає довше — інакше він показав би
 * помилку, коли дія в ЕСОЗ ще могла завершитися успішно.
 */
export const REQUEST_TIMEOUT_MS = 90_000;
export const MSG_NETWORK = 'Немає з’єднання із сервером. Перевірте інтернет і спробуйте ще раз.';
export const MSG_TIMEOUT = 'Сервер не відповів вчасно. Перевірте з’єднання з інтернетом і спробуйте ще раз.';
export const MSG_GENERIC = 'Сталася помилка. Спробуйте пізніше.';
export const MSG_UNAVAILABLE = 'Сервер тимчасово недоступний. Спробуйте пізніше.';
export const MSG_BAD_RESPONSE = 'Сервер повернув некоректну відповідь. Спробуйте пізніше.';

/**
 * fetch з обмеженням часу очікування (AbortController). Мережа недоступна або сервер не відповів —
 * ApiError зі статусом 0 і текстом українською (не системне повідомлення англійською).
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new ApiError(timedOut ? MSG_TIMEOUT : MSG_NETWORK, 0, timedOut ? { timeout: true } : {});
  } finally {
    clearTimeout(timer);
  }
}

/** Текст помилки, якщо сервер (або проксі перед ним) не повернув JSON з полем error. */
export function fallbackMessage(status: number): string {
  if (status === 413) return 'Файл більший за 20 МБ';
  if (status === 429) return 'Забагато запитів. Спробуйте за кілька хвилин.';
  if (status === 502 || status === 503 || status === 504) return MSG_UNAVAILABLE;
  return MSG_GENERIC;
}

/** Тіло відповіді як JSON-об'єкт: порожня відповідь (204) — {}, не JSON (HTML-сторінка проксі, обірване з'єднання) — null. */
export async function readJson(resp: Response): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    return resp.status === 204 || resp.status === 205 ? {} : null;
  }
  if (parsed === null || parsed === undefined) return {};
  return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Відповідь BFF -> дані або ApiError з текстом сервера (Додаток 1) чи українським текстом за HTTP-статусом. */
export async function parseResponse<T>(resp: Response): Promise<T> {
  const data = await readJson(resp);
  if (!resp.ok) {
    const body = data ?? {};
    const message = typeof body.error === 'string' && body.error ? body.error : fallbackMessage(resp.status);
    throw new ApiError(message, resp.status, body);
  }
  if (data === null) throw new ApiError(MSG_BAD_RESPONSE, resp.status);
  return data as T;
}

type Options = { method?: string; body?: unknown; token?: string | null; timeoutMs?: number };

export async function api<T = Record<string, unknown>>(path: string, { method = 'GET', body, token, timeoutMs }: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetchWithTimeout(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, timeoutMs);
  return parseResponse<T>(resp);
}
