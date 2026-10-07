import * as DocumentPicker from 'expo-document-picker';

import { ApiError } from './api';
import { API_BASE } from './config';

/**
 * Запити на зміну персональних даних (п.3.10.1–3.10.2 ТВ ПІС) і копії документів (п.3.6).
 * Логіка, тексти і формати запитів — як у веб-кабінеті (pis/web/index.html).
 */

// ---------------------------------------------------------------------------
// Типи відповідей BFF (відповіді ЕСОЗ без змін: data, urgent)
// ---------------------------------------------------------------------------

export type PersonShort = {
  first_name?: string | null;
  last_name?: string | null;
  second_name?: string | null;
  birth_date?: string | null;
  [key: string]: unknown;
};

export type PersonRequestSummary = {
  id: string;
  status?: string | null;
  channel?: string | null;
  inserted_at?: string | null;
  updated_at?: string | null;
  person?: PersonShort | null;
};

export type PersonRequestData = PersonRequestSummary & {
  patient_signed?: boolean;
  process_disclosure_data_consent?: boolean;
  /** HTML-форма запиту від ЕСОЗ. */
  content?: string | null;
};

/** Документ, копію якого треба завантажити (urgent.documents у Get Person Request Details). */
export type RequestDocument = { type: string; is_uploaded?: boolean; url?: string };

export type PersonRequestDetails = {
  data?: PersonRequestData;
  urgent?: { documents?: RequestDocument[] | null; [key: string]: unknown } | null;
  [key: string]: unknown;
};

/** Документ п.3.6 з "PIS. Initialize Person documents upload". */
export type PendingDocument = { type: string; url?: string };

export type DictionaryValue = { code: string; description?: string; is_active?: boolean };

// ---------------------------------------------------------------------------
// Статуси та дії
// ---------------------------------------------------------------------------

export const PERSON_REQUEST_STATUSES: Record<string, string> = {
  NEW: 'Новий',
  APPROVED: 'Підтверджений',
  SIGNED: 'Підписаний',
  REJECTED: 'Відхилений',
  CANCELLED: 'Скасований',
  CANCELED: 'Скасований',
  EXPIRED: 'Строк минув',
};

export function normalizeStatus(status?: string | null): string {
  return String(status ?? '').toUpperCase();
}

export function statusLabel(status?: string | null): string {
  const s = normalizeStatus(status);
  return PERSON_REQUEST_STATUSES[s] ?? s;
}

/** Продовжити (документи і підпис) — лише запит у статусі NEW. */
export function canContinue(status?: string | null): boolean {
  return normalizeStatus(status) === 'NEW';
}

/** Скасувати можна запит у статусі NEW або APPROVED. */
export function canReject(status?: string | null): boolean {
  return ['NEW', 'APPROVED'].includes(normalizeStatus(status));
}

/** Параметр маршруту Expo Router може прийти як рядок або масив рядків — береться перше значення. */
export function firstParam(value?: string | string[] | null): string {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : '';
}

/** Текст помилки для показу без побічних дій (вихід за недійсної сесії робить handleApiError в ефекті). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return 'Сталася помилка';
}

/** Сесія є, але доступ до ЕСОЗ у ній припинено — потрібен повторний вхід через ЕСОЗ. */
export function isEhealthRequired(e: unknown): boolean {
  return e instanceof ApiError && e.ehealthRequired;
}

/**
 * Захист від повторного запуску дії: стан busy оновлюється лише після перерендеру, тож швидке подвійне
 * натискання могло б двічі відкрити екран КЕП або двічі надіслати запит. Поки дія триває, нові виклики ігноруються.
 */
export function createExclusive(): (action: () => Promise<void>) => Promise<void> {
  let running = false;
  return async (action) => {
    if (running) return;
    running = true;
    try {
      await action();
    } finally {
      running = false;
    }
  };
}

export function personFullName(person?: PersonShort | null): string {
  if (!person) return '';
  return [person.last_name, person.first_name, person.second_name].filter(Boolean).join(' ');
}

/** Документи запиту, копії яких ще не завантажено. */
export function pendingDocuments(details?: PersonRequestDetails | null): RequestDocument[] {
  const docs = details?.urgent?.documents;
  return Array.isArray(docs) ? docs.filter((d) => d && d.type && !d.is_uploaded) : [];
}

// ---------------------------------------------------------------------------
// Маршрути BFF (api() додає префікс /api)
// ---------------------------------------------------------------------------

export const PERSON_REQUESTS_PATH = '/ehealth/person-requests';
export const DOCUMENTS_PATH = '/ehealth/documents';
export const DOCUMENTS_UPLOAD_PATH = '/ehealth/documents/upload';
export const DOCUMENTS_COMPLETE_PATH = '/ehealth/documents/complete';
export const DOCUMENT_TYPE_DICTIONARY_PATH = '/ehealth/dictionaries?name=DOCUMENT_TYPE';

export type PersonRequestAction = '' | '/sign-content' | '/complete' | '/reject' | '/documents/upload';

export function personRequestPath(id: string, action: PersonRequestAction = ''): string {
  return `${PERSON_REQUESTS_PATH}/${encodeURIComponent(id)}${action}`;
}

/** Тіло PATCH .../complete: підписаний КЕП контент (BASE64 CAdES). */
export function completePayload(signed: string): { signed_content: string } {
  return { signed_content: signed };
}

// ---------------------------------------------------------------------------
// Тексти (як у веб-кабінеті)
// ---------------------------------------------------------------------------

export const TEXTS = {
  signTitle: 'Підпис зміни персональних даних',
  signPurpose: 'Підпишіть запит на зміну персональних даних своїм КЕП.',
  completed: 'Персональні дані успішно змінено.',
  rejectConfirm: 'Скасувати запит на зміну персональних даних? Дію не можна буде відмінити.',
  formUnavailable: 'Електронна форма недоступна',
  documentsNeeded: 'Завантажте електронні копії документів (PDF, JPG, PNG, BMP, до 20 МБ):',
  documentsNotNeeded: 'Документи не потрібні або вже завантажені.',
  signAfterDocuments: 'Після завантаження документів підпишіть запит своїм КЕП.',
  noRequests: 'Запитів на зміну даних немає.',
  noSignContent: 'Не вдалося отримати дані для підпису',
  missingId: 'ЕСОЗ не повернула ідентифікатор запиту',
  noRequestId: 'Запит не знайдено. Поверніться до переліку запитів.',
  loading: 'Завантаження...',
  retry: 'Спробувати ще раз',
  ehealthLost: 'Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.',
  documentsTitle: 'Завантажте копії ваших документів',
  documentsLimited: 'До завантаження документів можливості особистого кабінету пацієнта будуть обмежені. Формати: PDF, JPG, PNG, BMP, до 20 МБ.',
  documentsIncomplete: 'Ще не всі документи завантажено. Завантажте решту документів.',
  documentsSent: 'Копії документів передано до ЕСОЗ.',
  uploading: 'Завантаження...',
  uploaded: '✓ Завантажено',
} as const;

export function documentsInfo(count: number): string {
  return count ? TEXTS.documentsNeeded : TEXTS.documentsNotNeeded;
}

/** Результат PATCH /ehealth/documents/complete: data — документи, яких ще бракує. */
export function documentsCompleteResult(body: { data?: unknown } | null | undefined): { done: boolean; message: string } {
  const missing = Array.isArray(body?.data) ? body.data.length : 0;
  return missing ? { done: false, message: TEXTS.documentsIncomplete } : { done: true, message: TEXTS.documentsSent };
}

// ---------------------------------------------------------------------------
// Довідник типів документів
// ---------------------------------------------------------------------------

/** Значення довідника з відповіді /ehealth/dictionaries (лише активні). */
export function parseDictionary(body: unknown): DictionaryValue[] {
  const dict = (body as { data?: { values?: unknown }[] } | null)?.data?.[0];
  const values = dict?.values;
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is DictionaryValue =>
    Boolean(v) && typeof (v as DictionaryValue).code === 'string' && (v as DictionaryValue).is_active !== false);
}

export function documentTypeLabel(values: DictionaryValue[], code: string): string {
  return values.find((v) => v.code === code)?.description || code;
}

// ---------------------------------------------------------------------------
// Файли копій документів (п.3.6.1)
// ---------------------------------------------------------------------------

export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp',
};
const MIME_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp', 'image/x-bmp': 'bmp',
};
/** Фільтр системного вибору файлів; формат додатково перевіряється за розширенням. */
export const DOCUMENT_PICKER_TYPES = Object.keys(MIME_EXTENSION);
const FORBIDDEN_NAME_CHARS = /[ЫЪЭЁыъэё@%&$^#]/;

export type PickedFile = {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
  /** Об'єкт File (лише для веб-платформи). */
  file?: Blob;
};

function extensionOf(name: string): string | null {
  const m = name.match(/\.([^./\\]+)$/);
  return m ? m[1].toLowerCase() : null;
}

/** Значення лише з власних ключів таблиці (не з Object.prototype: "x.constructor" — не дозволений формат). */
function own(map: Record<string, string>, key: string | null | undefined): string | undefined {
  return key && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Назва для передачі на сервер: деякі постачальники файлів Android віддають назву без розширення
 * (або з крапками в назві, напр. "Скан 03.10.2026") — тоді, якщо MIME-тип належить до дозволених форматів,
 * розширення додається за ним (сервер визначає формат за розширенням).
 */
export function uploadFileName(name: string, mimeType?: string): string {
  const base = name.trim() || 'document';
  const ext = extensionOf(base);
  if (own(EXTENSION_MIME, ext)) return base;
  const mime = mimeType ? mimeType.split(';')[0].trim().toLowerCase() : '';
  const fromMime = own(MIME_EXTENSION, mime);
  return fromMime ? `${base.replace(/\.+$/, '') || 'document'}.${fromMime}` : base;
}

/** Перевірка файлу перед завантаженням — ті самі правила і тексти, що у веб-кабінеті. Повертає текст помилки або null. */
export function validateDocumentFile(name: string, size?: number | null): string | null {
  if (!own(EXTENSION_MIME, extensionOf(name))) return 'Дозволені формати: PDF, JPG, PNG, BMP';
  if (typeof size === 'number' && size > DOCUMENT_MAX_BYTES) return 'Файл більший за 20 МБ';
  if (FORBIDDEN_NAME_CHARS.test(name)) return 'Назва файлу містить заборонені символи';
  return null;
}

export function mimeTypeFor(name: string, fallback?: string): string {
  return own(EXTENSION_MIME, extensionOf(name)) || fallback || 'application/octet-stream';
}

/** Готує обраний файл до завантаження: назва з розширенням і перевірка за п.3.6.1. */
export function prepareUpload(picked: PickedFile): { file: PickedFile; error: null } | { file: null; error: string } {
  const name = uploadFileName(picked.name, picked.mimeType);
  const error = validateDocumentFile(name, picked.size);
  if (error) return { file: null, error };
  return { file: { ...picked, name, mimeType: mimeTypeFor(name, picked.mimeType) }, error: null };
}

/** Системний вибір файлу копії документа; null — користувач скасував вибір. */
export async function pickDocumentFile(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: DOCUMENT_PICKER_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  const a = result.assets[0];
  return { uri: a.uri, name: a.name, size: a.size, mimeType: a.mimeType, file: a.file };
}

/**
 * Завантаження копії документа (multipart/form-data: type, file) на BFF —
 * /ehealth/person-requests/<id>/documents/upload або /ehealth/documents/upload.
 * Помилки — як у api(): ApiError з текстом від сервера.
 */
export async function uploadDocument(path: string, type: string, picked: PickedFile, token: string | null):
  Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append('type', type);
  if (picked.file) {
    form.append('file', picked.file, picked.name);
  } else {
    // React Native: файл передається як {uri, name, type}
    form.append('file', { uri: picked.uri, name: picked.name, type: mimeTypeFor(picked.name, picked.mimeType) } as unknown as Blob);
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let resp: Response;
  try {
    // Content-Type з межею multipart встановлює fetch
    resp = await fetch(`${API_BASE}/api${path}`, { method: 'POST', headers, body: form });
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
    const message = typeof data.error === 'string' ? data.error
      : resp.status === 413 ? 'Файл більший за 20 МБ' : 'Сталася помилка. Спробуйте пізніше.';
    throw new ApiError(message, resp.status, data);
  }
  return data;
}
