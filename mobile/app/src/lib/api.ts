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

type Options = { method?: string; body?: unknown; token?: string | null };

export async function api<T = Record<string, unknown>>(path: string, { method = 'GET', body, token }: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Немає з’єднання із сервером. Перевірте інтернет і спробуйте ще раз.', 0);
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!resp.ok) {
    const message = typeof data.error === 'string' ? data.error : 'Сталася помилка. Спробуйте пізніше.';
    throw new ApiError(message, resp.status, data);
  }
  return data as T;
}
