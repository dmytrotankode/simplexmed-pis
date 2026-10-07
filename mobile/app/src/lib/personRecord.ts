/**
 * Запис про пацієнта (п.3.9.2) і статуси верифікації (п.3.9.3) для показу в застосунку — як renderPersonDetails
 * і loadVerification веб-кабінету. Атрибути без значення показуються порожніми (п.3.9.2.1).
 */
import { type DictValue, REGISTRATION_DOCUMENT_TYPES, type Rec, loadDictionary } from './personForm';

export const RECORD_DICTIONARIES = [
  'GENDER', 'COUNTRY', 'ADDRESS_TYPE', 'SETTLEMENT_TYPE', 'STREET_TYPE', 'DOCUMENT_TYPE', 'PHONE_TYPE',
  'PERSON_VERIFICATION_STATUSES', 'PERSON_VERIFICATION_STATUS_REASONS',
] as const;
export type RecordDictName = (typeof RECORD_DICTIONARIES)[number];
export type RecordDicts = Partial<Record<RecordDictName, DictValue[]>>;

/** Довідники для запису; недоступний довідник не заважає показу (замість опису — код). */
export async function loadRecordDictionaries(token?: string | null): Promise<RecordDicts> {
  const lists = await Promise.all(RECORD_DICTIONARIES.map((n) => loadDictionary(n, token).catch(() => [] as DictValue[])));
  return Object.fromEntries(RECORD_DICTIONARIES.map((n, i) => [n, lists[i]])) as RecordDicts;
}

/** Значення "value" (опис) довідника для коду; без коду — порожньо. */
export function dictText(dicts: RecordDicts, name: RecordDictName, code: unknown): string {
  if (code === null || code === undefined || code === '') return '';
  const value = String(code);
  return dicts[name]?.find((v) => v.code === value)?.description || value;
}

/** п.3.9.2.1.3: документи групуються за категоріями «посвідчення особи» і «про набуття цивільної дієздатності». */
export function groupDocuments(documents: unknown): { identity: Rec[]; capacity: Rec[] } {
  const list = (Array.isArray(documents) ? documents : []).filter((d): d is Rec => Boolean(d) && typeof d === 'object');
  return {
    identity: list.filter((d) => REGISTRATION_DOCUMENT_TYPES.includes(d.type)),
    capacity: list.filter((d) => !REGISTRATION_DOCUMENT_TYPES.includes(d.type)),
  };
}

export function noTaxIdText(value: unknown): string {
  return value === true ? 'Так' : value === false ? 'Ні' : '';
}

export function preferredWayText(value: unknown): string {
  return value === 'email' ? 'Електронна пошта' : value === 'phone' ? 'Телефон' : '';
}

/** п.3.9.2.1.2.2: немає адреси фактичного місця проживання. */
export function lacksResidence(addresses: unknown): boolean {
  return !(Array.isArray(addresses) && addresses.some((a) => a?.type === 'RESIDENCE'));
}

export function fullName(p: Rec | null | undefined): string {
  return p ? [p.last_name, p.first_name, p.second_name].filter(Boolean).join(' ') : '';
}

export function maskSecret(secret: unknown): string {
  return secret ? '••••••' : '';
}

export type VerificationItem = {
  direction: string;
  label: string;
  status: string;
  reason?: string | null;
  comment?: string | null;
  message?: string | null;
};

const STATUS_FALLBACK: Record<string, string> = {
  VERIFIED: 'Верифіковано', NOT_VERIFIED: 'Не верифіковано', VERIFICATION_NEEDED: 'Потребує верифікації',
  VERIFICATION_NOT_NEEDED: 'Не потребує верифікації', IN_REVIEW: 'На перевірці',
};

export function verificationStatusText(dicts: RecordDicts, status: string): string {
  const fromDict = dictText(dicts, 'PERSON_VERIFICATION_STATUSES', status);
  return fromDict && fromDict !== status ? fromDict : STATUS_FALLBACK[status] ?? status;
}

/** п.3.9.3.2–3.9.3.7: причина статусу верифікації (verification_reason) — описом із довідника. */
export function verificationReasonText(dicts: RecordDicts, reason: unknown): string {
  return dictText(dicts, 'PERSON_VERIFICATION_STATUS_REASONS', reason);
}

/** Текст з https-посиланнями (портал підтримки НСЗУ, п.3.9.3.3) — частини для показу з натисканням на посилання. */
export function splitLinks(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  const re = /https:\/\/[^\s<>"')]+/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const url = m[0].replace(/[.,;:]+$/, '');
    parts.push({ text: url, url });
    last = m.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
