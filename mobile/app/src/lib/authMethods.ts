import { ApiError, api } from './api';

/**
 * Методи автентифікації (п.3.9.4, 3.10.3, 3.10.4 ТВ ПІС) і доступи, надані застосункам (п.3.8).
 * Логіка і тексти — як у веб-кабінеті (pis/web/index.html: loadAuthMethods, authMethodSubmit,
 * resendAuthMethodOtp, renameAuthMethod, loadApps, deleteApp, loadScopeDescriptions).
 */

export type AuthMethod = {
  id: string;
  type: string;
  phone_number?: string | null;
  alias?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  is_active?: boolean;
  [key: string]: unknown;
};

export type Approval = {
  id: string;
  client_name?: string | null;
  client_id?: string | null;
  scope?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
};

export type AuthMethodRequest = { id?: string; status?: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Тексти (як у веб-кабінеті)
// ---------------------------------------------------------------------------

const NOTICE_TAIL = ' Це допоможе забезпечити зручність отримання електронних медичних сервісів та вищий контроль Вами доступу до інформації про Вас.';
/** п.3.9.4.2 */
export const NOTICE_NO_METHODS = 'Необхідно внести новий метод автентифікації!' + NOTICE_TAIL;
/** п.3.9.4.3 */
export const NOTICE_OFFLINE = 'Додайте новий метод автентифікації з використанням номеру телефону.' + NOTICE_TAIL;
export const MSG_NO_ACTIVE_METHODS = 'Активних методів автентифікації в ЕСОЗ не знайдено.';
/** п.3.10.3.3, 3.10.3.5.1 */
export const MSG_CREATED = 'Метод автентифікації створено.';
/** п.3.10.3.4 */
export const MSG_SMS_SENT = 'На вказаний номер надіслано SMS з кодом підтвердження.';
/** п.3.10.3.4.1 */
export const MSG_RESENT = 'Код надіслано повторно.';
export const MSG_PHONE_FORMAT = 'Номер телефону у форматі +380XXXXXXXXX';
export const MSG_OTP_REQUIRED = 'Введіть код із SMS';
export const MSG_ALIAS_REQUIRED = 'Вкажіть назву методу автентифікації';
export const MSG_NO_APPS = 'Наданих доступів не знайдено.';
const MSG_GENERIC = 'Сталася помилка. Спробуйте пізніше.';

export const METHOD_TYPES: Record<string, string> = {
  OTP: 'SMS (OTP)',
  OFFLINE: 'Офлайн (документи)',
  THIRD_PERSON: 'Третя особа',
};

export function methodTypeLabel(type: string | null | undefined): string {
  const t = String(type ?? '');
  return METHOD_TYPES[t] ?? t;
}

// ---------------------------------------------------------------------------
// Методи автентифікації: відображення
// ---------------------------------------------------------------------------

/** Активні методи: ЕСОЗ повертає is_active; неактивні веб-кабінет не показує. */
export function activeMethods(list: AuthMethod[] | null | undefined): AuthMethod[] {
  return (list ?? []).filter((m) => m && m.is_active !== false);
}

/** Повідомлення п.3.9.4.2 / 3.9.4.3 або null. */
export function authMethodsNotice(methods: AuthMethod[]): string | null {
  if (!methods.length) return NOTICE_NO_METHODS;
  if (methods.some((m) => m.type === 'OFFLINE')) return NOTICE_OFFLINE;
  return null;
}

/** п.3.10.4.1: назву можна змінити лише для активного методу OTP. */
export function canRename(m: AuthMethod): boolean {
  return m.type === 'OTP' && m.is_active !== false;
}

/** Деактивувати можна лише метод OTP — інші типи ПІС не створює (п.3.10.3.1). */
export function canDeactivate(m: AuthMethod): boolean {
  return m.type === 'OTP' && m.is_active !== false;
}

/** Як метод називається в діалогах: назва або номер телефону. */
export function methodTitle(m: AuthMethod): string {
  return String(m.alias || m.phone_number || methodTypeLabel(m.type));
}

export function deactivateConfirmText(m: AuthMethod, methods: AuthMethod[]): string {
  const last = activeMethods(methods).filter((x) => x.id !== m.id).length === 0;
  return `Деактивувати метод автентифікації «${methodTitle(m)}»? Відновити його буде неможливо — за потреби номер доведеться додати знову.`
    + (last ? ' Це ваш останній активний метод автентифікації.' : '');
}

// ---------------------------------------------------------------------------
// Методи автентифікації: створення (п.3.10.3) і зміна назви (п.3.10.4)
// ---------------------------------------------------------------------------

/**
 * Номер без пробілів, дефісів і дужок, які додають автозаповнення і клавіатура телефону
 * («+380 50 111-22-33»). Сам формат перевіряє validatePhone так само, як веб-кабінет.
 */
export function normalizePhoneInput(phone: string): string {
  return phone.replace(/[\s\-()]/g, '');
}

/** Помилка перевірки номера або null. Формат — як у веб-кабінеті: +38 і 10 цифр. */
export function validatePhone(phone: string): string | null {
  return /^\+38[0-9]{10}$/.test(normalizePhoneInput(phone)) ? null : MSG_PHONE_FORMAT;
}

/** Код із SMS: 4–6 цифр. */
export function validateOtp(code: string): string | null {
  return /^[0-9]{4,6}$/.test(code.trim()) ? null : MSG_OTP_REQUIRED;
}

export function validateAlias(alias: string): string | null {
  return alias.trim() ? null : MSG_ALIAS_REQUIRED;
}

/** Тіло POST /ehealth/authentication-method-requests (лише тип OTP — тип додає сервер). */
export function buildCreatePayload(phone: string, alias: string): { phone_number: string; alias: string | null } {
  return { phone_number: normalizePhoneInput(phone), alias: alias.trim() || null };
}

export type CreateOutcome =
  | { phase: 'done'; message: string }
  | { phase: 'otp'; requestId: string; message: string }
  | { phase: 'error'; message: string };

/**
 * Результат створення запиту: COMPLETED — метод створено без верифікації номера (п.3.10.3.3);
 * інакше потрібен код із SMS (п.3.10.3.4). Без id запиту підтвердити код неможливо — помилка.
 */
export function createOutcome(data: AuthMethodRequest | null | undefined): CreateOutcome {
  if (String(data?.status ?? '').toUpperCase() === 'COMPLETED') return { phase: 'done', message: MSG_CREATED };
  const requestId = String(data?.id ?? '').trim();
  if (!requestId) return { phase: 'error', message: MSG_GENERIC };
  return { phase: 'otp', requestId, message: MSG_SMS_SENT };
}

const enc = encodeURIComponent;

export async function fetchAuthMethods(token: string | null): Promise<AuthMethod[]> {
  const r = await api<{ data?: AuthMethod[] }>('/ehealth/person/authentication-methods', { token });
  return activeMethods(r.data);
}

export async function createAuthMethodRequest(token: string | null, phone: string, alias: string): Promise<CreateOutcome> {
  const r = await api<{ data?: AuthMethodRequest }>('/ehealth/authentication-method-requests', {
    method: 'POST', token, body: buildCreatePayload(phone, alias),
  });
  return createOutcome(r.data);
}

export async function approveAuthMethodRequest(token: string | null, requestId: string, code: string): Promise<void> {
  await api(`/ehealth/authentication-method-requests/${enc(requestId)}/approve`, {
    method: 'PATCH', token, body: { verification_code: code.trim() },
  });
}

export async function resendAuthMethodOtp(token: string | null, requestId: string): Promise<void> {
  await api(`/ehealth/authentication-method-requests/${enc(requestId)}/resend-otp`, { method: 'POST', token });
}

export async function renameAuthMethod(token: string | null, methodId: string, alias: string): Promise<void> {
  await api(`/ehealth/authentication-methods/${enc(methodId)}`, { method: 'PATCH', token, body: { alias: alias.trim() } });
}

export async function deactivateAuthMethod(token: string | null, methodId: string): Promise<void> {
  await api(`/ehealth/authentication-methods/${enc(methodId)}/deactivate`, { method: 'PATCH', token });
}

// ---------------------------------------------------------------------------
// Доступи застосунків (п.3.8)
// ---------------------------------------------------------------------------

type Dictionary = { values?: { code?: string; description?: string }[] };

/** code → description з довідника SCOPES (відповідь GET /ehealth/dictionaries?name=SCOPES). */
export function scopeDescriptions(response: { data?: Dictionary[] } | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  const dict = (response?.data ?? [])[0];
  for (const v of dict?.values ?? []) {
    if (v?.code) map[v.code] = v.description ?? v.code;
  }
  return map;
}

/** Перелік скоупів (рядок через пробіл) описами з довідника; невідомі — кодом. */
export function describeScopes(scope: string | null | undefined, map: Record<string, string>): string[] {
  return String(scope ?? '').split(' ').filter(Boolean).map((code) => map[code] || code);
}

const normId = (v: unknown) => String(v ?? '').trim().toLowerCase();

/**
 * Чи це доступ, наданий самій ПІС SimplexMed (той самий client_id, що й у /api/config).
 * UUID порівнюються без урахування регістру: у конфігурації і в ЕСОЗ він може бути записаний по-різному.
 */
export function isCurrentClient(app: Approval, clientId: string | null | undefined): boolean {
  const own = normId(clientId);
  return own !== '' && normId(app.client_id) === own;
}

/** Підтвердження відкликання; для власної ПІС — попередження п.3.8.2.1. */
export function revokeConfirmText(app: Approval, current: boolean): string {
  const base = `Відкликати доступ застосунку «${app.client_name ?? ''}» до ваших даних в ЕСОЗ?`;
  if (!current) return base;
  return `${base}\n\nЦе застосунок, через який ви зараз працюєте: доступ до функціональності Системи через нього буде припинено. `
    + 'Для продовження роботи потрібно буде повторно авторизуватися.';
}

export async function fetchApps(token: string | null): Promise<Approval[]> {
  const r = await api<{ data?: Approval[] }>('/ehealth/apps', { token });
  return r.data ?? [];
}

export async function fetchAppDetails(token: string | null, id: string): Promise<Approval | null> {
  const r = await api<{ data?: Approval }>(`/ehealth/apps/${enc(id)}`, { token });
  return r.data ?? null;
}

export async function revokeApp(token: string | null, id: string): Promise<void> {
  await api(`/ehealth/apps/${enc(id)}`, { method: 'DELETE', token });
}

/** Довідник SCOPES; недоступний довідник не заважає показати перелік (показуються коди). */
export async function fetchScopeDescriptions(): Promise<Record<string, string>> {
  try {
    return scopeDescriptions(await api<{ data?: Dictionary[] }>('/ehealth/dictionaries?name=SCOPES'));
  } catch {
    return {};
  }
}

/** client_id ПІС для перевірки п.3.8.2.1; null, якщо конфігурація недоступна. */
export async function fetchOwnClientId(): Promise<string | null> {
  try {
    const r = await api<{ client_id?: string }>('/config');
    return r.client_id || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Усі атрибути відповіді (п.3.8.1.2, 3.9.4.1.5: «інші параметри за запитом Користувача»)
// ---------------------------------------------------------------------------

const DETAIL_LABELS: Record<string, string> = {
  id: 'Ідентифікатор',
  type: 'Тип',
  phone_number: 'Номер телефону',
  alias: 'Назва',
  value: 'Ідентифікатор третьої особи',
  started_at: 'Діє з',
  ended_at: 'Діє до',
  is_active: 'Активний',
  person_id: 'Ідентифікатор пацієнта',
  inserted_at: 'Створено',
  inserted_by: 'Ким створено',
  updated_at: 'Оновлено',
  updated_by: 'Ким оновлено',
  confidant_person: 'Довірена особа',
  'confidant_person.name': 'Довірена особа',
  'confidant_person.phones': 'Телефони довіреної особи',
  'confidant_person.phones.type': 'Тип телефону довіреної особи',
  'confidant_person.phones.number': 'Телефон довіреної особи',
  client_name: 'Назва клієнта',
  client_id: 'Ідентифікатор клієнта',
  scope: 'Перелік доступів',
  created_at: 'Дата створення',
  user_id: 'Ідентифікатор користувача',
  applicant_user_id: 'Ідентифікатор заявника',
};

export type DetailRow = { key: string; label: string; value: string };

/** Підпис атрибута; для елементів масивів (phones.0.number) — підпис без індексу. */
function labelFor(key: string): string {
  return DETAIL_LABELS[key] ?? DETAIL_LABELS[key.replace(/\.\d+(?=\.|$)/g, '')] ?? key;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Так' : 'Ні';
  return String(v);
}

/** Плаский перелік усіх атрибутів об'єкта ЕСОЗ (вкладені — через крапку). */
export function detailRows(obj: Record<string, unknown> | null | undefined, prefix = ''): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      const nested = Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), x])) : (v as Record<string, unknown>);
      const inner = detailRows(nested, key);
      if (inner.length) rows.push(...inner);
      else rows.push({ key, label: labelFor(key), value: '—' });
    } else {
      rows.push({ key, label: labelFor(key), value: formatValue(v) });
    }
  }
  return rows;
}

/** Текст помилки без побічних дій (вихід за 401 робить session.handleApiError). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error && e.message ? e.message : MSG_GENERIC;
}
