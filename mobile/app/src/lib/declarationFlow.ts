/**
 * Подання декларації (п.3.11.1–3.11.2 ТВ ПІС): пошук лікаря в кеші реєстрів, створення запиту,
 * підпис КЕП і відхилення. Запити, тексти і правила — як у веб-кабінеті (pis/web/index.html).
 */
import { ApiError, api } from './api';

// ---------------------------------------------------------------------------
// Типи даних BFF
// ---------------------------------------------------------------------------

export type DictValue = { code: string; description?: string | null; is_active?: boolean };
export type DictName = 'SPECIALITY_TYPE' | 'GENDER' | 'EDUCATION_DEGREE' | 'QUALIFICATION_TYPE' | 'SPECIALITY_LEVEL';
export type Dictionaries = Partial<Record<DictName, DictValue[]>>;

/** Рядок результатів GET /registry/doctors (лікар у конкретному МНП). */
export type DoctorRow = {
  employee_id: string;
  division_id: string;
  legal_entity_id: string;
  speciality?: string | null;
  last_name?: string | null;
  first_name?: string | null;
  second_name?: string | null;
  gender?: string | null;
  age?: number | null;
  division_name?: string | null;
  address_text?: string | null;
  legal_entity_name?: string | null;
  declarations_limit?: number | null;
  declarations_count?: number | null;
  in_contract?: boolean;
  overlimit?: boolean;
};

export type DoctorSpeciality = { speciality?: string | null; speciality_officio?: boolean; level?: string | null };
export type DoctorEducation = { degree?: string | null; speciality?: string | null; institution_name?: string | null };
export type DoctorQualification = { type?: string | null; speciality?: string | null };

/** GET /registry/doctors/<employee_id> (п.3.11.1.5). */
export type DoctorDetails = {
  employee_id: string;
  last_name?: string | null;
  first_name?: string | null;
  second_name?: string | null;
  gender?: string | null;
  age?: number | null;
  working_experience?: number | string | null;
  about_myself?: string | null;
  declarations_limit?: number | null;
  declarations_count?: number | null;
  specialities?: DoctorSpeciality[];
  educations?: DoctorEducation[];
  qualifications?: DoctorQualification[];
  warning?: string | null;
  [key: string]: unknown;
};

/** GET /registry/divisions (МНП закладу, п.3.11.1.3.1). */
export type Division = {
  id: string;
  name?: string | null;
  address_text?: string | null;
  legal_entity_id?: string | null;
  in_contract?: boolean;
};

type PersonName = { last_name?: string | null; first_name?: string | null; second_name?: string | null };

/** Елемент GET /ehealth/declaration-requests. */
export type DeclarationRequest = {
  id: string;
  declaration_number?: string | null;
  status?: string | null;
  start_date?: string | null;
  inserted_at?: string | null;
  person?: (PersonName & { id?: string }) | null;
  [key: string]: unknown;
};

/** GET /ehealth/declaration-requests/<id> і відповідь POST /ehealth/declaration-requests. */
export type DeclarationRequestDetails = {
  id?: string;
  declaration_number?: string | null;
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  inserted_at?: string | null;
  content?: string | null;
  data_to_be_signed?: { content?: string | null; person?: Record<string, unknown> | null; [key: string]: unknown } | null;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Тексти (як у веб-кабінеті)
// ---------------------------------------------------------------------------

export const MSG_NO_CONTRACT = 'Щоб отримувати медичні послуги безоплатно за Програмою медичних гарантій, оберіть заклад, який має договір з НСЗУ. Обраний вами медичний заклад не має договору з НСЗУ або це місце надання послуг не входить до такого договору. Через це держава не зможе оплачувати надані вам послуги первинної медичної допомоги за декларацією. Радимо сконтактувати з закладом та уточнити, чи можна подати декларацію саме тут.';
export const MSG_OVERLIMIT = 'У обраного лікаря перевищено ліміт поданих декларацій. Запит буде надіслано лікарю на погодження — очікування до 7 календарних днів, і запит може бути відхилено.';
export const MSG_NOT_FOUND = 'Лікарів за цими параметрами не знайдено. Перелік оновлюється з реєстрів ЕСОЗ щонайменше раз на добу.';
export const MSG_SEARCH_HINT = 'Задайте фільтри та натисніть «Знайти».';
export const SIGN_TITLE = 'Підпис декларації';
export const SIGN_PURPOSE = 'Підпишіть декларацію про вибір лікаря своїм КЕП. Дані з підпису мають належати вам.';
export const SIGN_CONTINUE = 'Продовжити підписання?';
export const SIGN_DONE = 'Запит на декларацію підписано.';
export const REJECT_CONFIRM = 'Відхилення запиту на декларацію є незворотною дією. Відхилити запит?';
export const FORM_UNAVAILABLE = 'Електронна форма недоступна.';

export const DECLARATION_REQUEST_STATUSES: Record<string, string> = {
  new: 'Новий (очікує підпису)', approved: 'Погоджується лікарем', signed: 'Підписаний',
  expired: 'Строк минув', rejected: 'Відхилений', cancelled: 'Скасований',
};

// ---------------------------------------------------------------------------
// Довідники
// ---------------------------------------------------------------------------

export const DOCTOR_DICTIONARIES: DictName[] = ['SPECIALITY_TYPE', 'GENDER', 'EDUCATION_DEGREE', 'QUALIFICATION_TYPE', 'SPECIALITY_LEVEL'];

/** Спеціальності лікарів первинної допомоги (п.3.11.1.4). */
export const SPECIALITY_CODES = ['FAMILY_DOCTOR', 'THERAPIST', 'PEDIATRICIAN'] as const;
/** Підписи на випадок, якщо довідник SPECIALITY_TYPE не завантажився. */
const SPECIALITY_FALLBACK: Record<string, string> = {
  FAMILY_DOCTOR: 'Лікар загальної практики – сімейний лікар', THERAPIST: 'Терапевт', PEDIATRICIAN: 'Педіатр',
};

/** Опис значення довідника; якщо його немає — код, якщо немає коду — «—». */
export function dictLabel(values: DictValue[] | undefined, code?: string | null): string {
  return (values ?? []).find((v) => v.code === code)?.description || code || '—';
}

export type Option = { value: string; label: string };

export function specialityOptions(dicts: Dictionaries): Option[] {
  return [
    { value: '', label: 'Усі доступні' },
    ...SPECIALITY_CODES.map((code) => {
      const label = dictLabel(dicts.SPECIALITY_TYPE, code);
      return { value: code, label: label === code ? SPECIALITY_FALLBACK[code] : label };
    }),
  ];
}

export const GENDER_OPTIONS: Option[] = [
  { value: '', label: 'Будь-яка' }, { value: 'MALE', label: 'Чоловіча' }, { value: 'FEMALE', label: 'Жіноча' },
];
export const OVERLIMIT_OPTIONS: Option[] = [
  { value: '', label: 'Будь-який' }, { value: 'false', label: 'Є вільні місця' }, { value: 'true', label: 'Ліміт досягнуто' },
];
export const CONTRACT_OPTIONS: Option[] = [
  { value: '', label: 'Будь-який' }, { value: 'true', label: 'МНП у договорі' }, { value: 'false', label: 'Без договору' },
];

// ---------------------------------------------------------------------------
// Пошук лікаря (п.3.11.1.2–3.11.1.3)
// ---------------------------------------------------------------------------

export type DoctorFilters = {
  name: string;
  speciality: string;
  gender: string;
  legalEntity: string;
  division: string;
  address: string;
  overlimit: string;
  inContract: string;
};

export const EMPTY_FILTERS: DoctorFilters = {
  name: '', speciality: '', gender: '', legalEntity: '', division: '', address: '', overlimit: '', inContract: '',
};

/** Обмеження пошуку закладом (СГуСОЗ) і/або місцем надання послуг (МНП). */
export type SearchScope = { legalEntityId: string | null; divisionId: string | null; label: string };
export const EMPTY_SCOPE: SearchScope = { legalEntityId: null, divisionId: null, label: '' };

export const PAGE_SIZE = 25;

/** Параметри GET /registry/doctors — ті самі й у тому ж порядку, що у веб-кабінеті (limit = розмір сторінки + 1). */
export function buildDoctorQuery(filters: DoctorFilters, scope: SearchScope, offset: number, pageSize = PAGE_SIZE): string {
  const pairs: [string, string][] = [
    ['name', filters.name.trim()],
    ['speciality', filters.speciality],
    ['gender', filters.gender],
    ['legal_entity', filters.legalEntity.trim()],
    ['division', filters.division.trim()],
    ['address', filters.address.trim()],
    ['overlimit', filters.overlimit],
    ['in_contract', filters.inContract],
    ['limit', String(pageSize + 1)],
    ['offset', String(offset)],
  ];
  if (scope.legalEntityId) pairs.push(['legal_entity_id', scope.legalEntityId]);
  if (scope.divisionId) pairs.push(['division_id', scope.divisionId]);
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** step 0 — нова пошукова видача, ±1 — сусідня сторінка. */
export function nextOffset(current: number, step: -1 | 0 | 1, pageSize = PAGE_SIZE): number {
  return step === 0 ? 0 : Math.max(0, current + step * pageSize);
}

/** Сервер повертає на 1 рядок більше за сторінку: так видно, чи є наступна. */
export function splitPage<T>(rows: T[], pageSize = PAGE_SIZE): { rows: T[]; hasNext: boolean } {
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

/** п.3.11.1.3.1: обрано заклад — його лікарі та перелік його МНП. */
export function scopeForLegalEntity(d: DoctorRow): SearchScope {
  return { legalEntityId: d.legal_entity_id, divisionId: null, label: `Заклад: ${d.legal_entity_name ?? ''}` };
}

/** п.3.11.1.3.2: обрано МНП (з рядка лікаря) — лікарі цього МНП. */
export function scopeForDivision(scope: SearchScope, d: DoctorRow): SearchScope {
  return { ...scope, divisionId: d.division_id, label: `Місце надання послуг: ${d.division_name ?? ''}` };
}

/** Обрано МНП з переліку МНП закладу. */
export function scopeForDivisionRow(scope: SearchScope, v: Division): SearchScope {
  return { ...scope, divisionId: v.id, label: `Місце надання послуг: ${v.name ?? ''}` };
}

export function doctorKey(d: DoctorRow): string {
  return `${d.employee_id}:${d.division_id}`;
}

export function fullName(p: PersonName | null | undefined): string {
  return p ? [p.last_name, p.first_name, p.second_name].filter(Boolean).join(' ') : '';
}

export function genderAgeText(d: { gender?: string | null; age?: number | null }, genders?: DictValue[]): string {
  return dictLabel(genders, d.gender) + (d.age ? `, ${d.age} р.` : '');
}

export function declarationsText(limit?: number | null, count?: number | null): string {
  return limit == null ? '—' : `${count ?? 0} / ${limit}`;
}

export function specialityLines(d: DoctorDetails, dicts: Dictionaries): string[] {
  return (d.specialities ?? []).map((s) => dictLabel(dicts.SPECIALITY_TYPE, s.speciality) +
    (s.speciality_officio ? ' (основна)' : '') + (s.level ? `, ${dictLabel(dicts.SPECIALITY_LEVEL, s.level)}` : ''));
}

export function educationLines(d: DoctorDetails, dicts: Dictionaries): string[] {
  return (d.educations ?? []).map((e) => `${dictLabel(dicts.EDUCATION_DEGREE, e.degree)} — ${dictLabel(dicts.SPECIALITY_TYPE, e.speciality)}` +
    (e.institution_name ? `, ${e.institution_name}` : ''));
}

export function qualificationLines(d: DoctorDetails, dicts: Dictionaries): string[] {
  return (d.qualifications ?? []).map((q) => `${dictLabel(dicts.QUALIFICATION_TYPE, q.type)} — ${dictLabel(dicts.SPECIALITY_TYPE, q.speciality)}`);
}

// ---------------------------------------------------------------------------
// Вибір лікаря і запит на декларацію (п.3.11.1.6–3.11.1.8)
// ---------------------------------------------------------------------------

/** Попередження перед створенням запиту, у порядку показу; кожне потребує підтвердження «Продовжити?». */
export function chooseDoctorConfirmations(d: DoctorRow): string[] {
  const out: string[] = [];
  if (d.overlimit) out.push(MSG_OVERLIMIT);
  if (!d.in_contract) out.push(MSG_NO_CONTRACT);
  return out;
}

export function createRequestBody(d: DoctorRow): { employee_id: string; division_id: string } {
  return { employee_id: d.employee_id, division_id: d.division_id };
}

/** Скільки місць лишилося до рекомендованого ліміту (null — ліміт не встановлено). */
export function placesLeft(limit?: number | null, count?: number | null): number | null {
  return limit == null ? null : limit - (count ?? 0);
}

/** Попередження у формі щойно створеного запиту: залишилося менше 20 місць. */
export function nearLimitWarning(left: number | null): string {
  return left != null && left > 0 && left < 20 ? `У лікаря залишилося ${left} місць до рекомендованого ліміту декларацій.` : '';
}

/** Параметр маршруту left (рядок) -> число або null. */
export function parsePlacesLeft(param: string | string[] | undefined): number | null {
  const raw = Array.isArray(param) ? param[0] : param;
  if (raw === undefined || raw === '' || !/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

export function requestStatusLabel(status?: string | null): string {
  const key = String(status ?? '').toLowerCase();
  return DECLARATION_REQUEST_STATUSES[key] || status || '—';
}

/** п.3.11.2.2–3.11.2.3: підписати можна запит NEW, відхилити — NEW або APPROVED. */
export function requestActions(status?: string | null): { canSign: boolean; canReject: boolean } {
  const st = String(status ?? '').toLowerCase();
  return { canSign: st === 'new', canReject: st === 'new' || st === 'approved' };
}

/**
 * HTML форми запиту від ЕСОЗ. Форму показуємо лише з даними Користувача: якщо ЕСОЗ очистила
 * персональні дані запиту (немає data_to_be_signed.person) або форми немає — null.
 */
export function requestFormContent(details: DeclarationRequestDetails | null | undefined): string | null {
  if (!details) return null;
  const toSign = details.data_to_be_signed;
  const content = toSign?.content || details.content;
  if (!content) return null;
  if (toSign && !toSign.person) return null;
  return content;
}

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/**
 * Мобільний масштаб для HTML форми, якщо в ній немає власного viewport. Тег ставиться всередину
 * <head> (або після <html> / <!DOCTYPE>): текст перед <!DOCTYPE> перемикає документ у режим quirks,
 * і форма ЕСОЗ відображалася б інакше, ніж у веб-кабінеті.
 */
export function withViewport(html: string): string {
  if (/<meta[^>]+name=["']?viewport/i.test(html)) return html;
  const anchor = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (!anchor) return VIEWPORT_META + html;
  const at = anchor.index + anchor[0].length;
  return html.slice(0, at) + VIEWPORT_META + html.slice(at);
}

/**
 * WebView з формою ЕСОЗ: дозволено лише сам вбудований документ (about:blank, якорі на ньому).
 * Решта переходів блокується — і в WebView, і без відкриття зовнішнього браузера чи інших застосунків.
 */
export function isFormNavigationAllowed(url: string): boolean {
  return url.startsWith('about:');
}

export function signRequestBody(signed: string): { signed_content: string } {
  return { signed_content: signed };
}

/** п.3.11.1.11: повідомлення за статусом запиту після підпису (формує сервер). */
export function signResultMessage(body: { message?: unknown } | null | undefined): string {
  return typeof body?.message === 'string' && body.message ? body.message : SIGN_DONE;
}

/** Рядок переліку «Запити на подання декларації» на екрані декларацій. */
export type DeclarationRequestRow = {
  id: string;
  number: string;
  statusLabel: string;
  /** ISO-дата для formatDate(): start_date або inserted_at. */
  date: string | null;
  openLabel: 'Продовжити' | 'Деталі';
  canReject: boolean;
};

export function toRequestRow(q: DeclarationRequest): DeclarationRequestRow {
  const st = String(q.status ?? '').toLowerCase();
  return {
    id: q.id,
    number: q.declaration_number || '—',
    statusLabel: requestStatusLabel(q.status),
    date: q.start_date || q.inserted_at || null,
    openLabel: st === 'new' ? 'Продовжити' : 'Деталі',
    canReject: requestActions(q.status).canReject,
  };
}

/** Текст помилки для користувача (без побічних ефектів; вихід за 401 робить session.handleApiError). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : 'Сталася помилка';
}

/** Помилка, яку не можна «проковтнути»: недійсна сесія або припинений доступ до ЕСОЗ. */
function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && (e.unauthorized || e.ehealthRequired);
}

/**
 * Відмова сервера/ЕСОЗ щодо дії із запитом (4xx, крім помилок сесії): стан запиту міг змінитися
 * (строк минув, запит скасовано), тож відомості на екрані треба перечитати.
 */
export function shouldReloadAfterActionError(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && !isAuthError(e);
}

// ---------------------------------------------------------------------------
// Виклики BFF
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;
const dictCache: Partial<Record<DictName, DictValue[]>> = {};

/** Довідник ЕСОЗ (публічний); невдале завантаження -> порожній перелік (без кешування). */
export async function loadDictionary(name: DictName): Promise<DictValue[]> {
  const cached = dictCache[name];
  if (cached) return cached;
  try {
    const r = await api<{ data?: { values?: DictValue[] }[] }>(`/ehealth/dictionaries?name=${enc(name)}`);
    const values = (r.data?.[0]?.values ?? []).filter((v) => v.is_active !== false);
    dictCache[name] = values;
    return values;
  } catch {
    return [];
  }
}

export async function loadDoctorDictionaries(): Promise<Dictionaries> {
  const lists = await Promise.all(DOCTOR_DICTIONARIES.map((n) => loadDictionary(n)));
  return Object.fromEntries(DOCTOR_DICTIONARIES.map((n, i) => [n, lists[i]])) as Dictionaries;
}

export async function searchDoctors(token: string, filters: DoctorFilters, scope: SearchScope, offset: number) {
  const r = await api<{ data?: DoctorRow[] }>(`/registry/doctors?${buildDoctorQuery(filters, scope, offset)}`, { token });
  return splitPage(r.data ?? []);
}

export async function fetchDoctor(token: string, employeeId: string): Promise<DoctorDetails> {
  const r = await api<{ data: DoctorDetails }>(`/registry/doctors/${enc(employeeId)}`, { token });
  return r.data;
}

/** МНП закладу; як у веб-кабінеті, помилка завантаження -> порожній перелік (крім помилок сесії). */
export async function fetchDivisions(token: string, legalEntityId: string): Promise<Division[]> {
  try {
    const r = await api<{ data?: Division[] }>(`/registry/divisions?legal_entity_id=${enc(legalEntityId)}`, { token });
    return r.data ?? [];
  } catch (e) {
    if (isAuthError(e)) throw e;
    return [];
  }
}

export async function createDeclarationRequest(token: string, d: DoctorRow): Promise<DeclarationRequestDetails> {
  const r = await api<{ data?: DeclarationRequestDetails }>('/ehealth/declaration-requests',
    { method: 'POST', token, body: createRequestBody(d) });
  return r.data ?? {};
}

export async function fetchDeclarationRequest(token: string, id: string): Promise<DeclarationRequestDetails> {
  const r = await api<{ data?: DeclarationRequestDetails }>(`/ehealth/declaration-requests/${enc(id)}`, { token });
  return r.data ?? {};
}

/** п.3.11.1.9–3.11.1.10: дані для підпису (рядок JSON) і попередження про ліміт. */
export async function fetchSignContent(token: string, id: string): Promise<{ content: string; warning: string | null }> {
  const r = await api<{ content?: string; warning?: string | null }>(`/ehealth/declaration-requests/${enc(id)}/sign-content`, { token });
  if (!r.content) throw new Error('ЕСОЗ не повернула дані для підпису декларації');
  return { content: r.content, warning: r.warning || null };
}

/** Надсилає підпис (base64 CAdES) і повертає повідомлення для користувача. */
export async function signDeclarationRequest(token: string, id: string, signed: string): Promise<string> {
  const r = await api<{ message?: unknown }>(`/ehealth/declaration-requests/${enc(id)}/sign`,
    { method: 'PATCH', token, body: signRequestBody(signed) });
  return signResultMessage(r);
}

export async function rejectDeclarationRequest(token: string, id: string): Promise<void> {
  await api(`/ehealth/declaration-requests/${enc(id)}/reject`, { method: 'PATCH', token });
}

/** Запити на подання декларації (п.3.11.2.1) для екрана декларацій. */
export async function fetchDeclarationRequests(token: string): Promise<DeclarationRequestRow[]> {
  const r = await api<{ data?: DeclarationRequest[] }>('/ehealth/declaration-requests', { token });
  return (r.data ?? []).map(toRequestRow);
}
