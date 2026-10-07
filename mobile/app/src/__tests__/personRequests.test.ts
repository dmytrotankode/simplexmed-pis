/* eslint-disable import/first -- jest.mock має стояти до імпортів модулів, які він підміняє */
jest.mock('expo-constants', () => ({ expoConfig: { extra: { pisApiBase: 'https://pis.test', ehealthEnv: 'pis-app' } } }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

import * as DocumentPicker from 'expo-document-picker';

import { ApiError } from '../lib/api';
import {
  DOCUMENT_MAX_BYTES, DOCUMENT_PICKER_TYPES, PERSON_REQUEST_STATUSES, TEXTS,
  canContinue, canReject, completePayload, documentTypeLabel, documentsCompleteResult, documentsInfo, mimeTypeFor,
  parseDictionary, pendingDocuments, personFullName, personRequestPath, pickDocumentFile, prepareUpload, statusLabel,
  uploadDocument, uploadFileName, validateDocumentFile,
} from '../lib/personRequests';

/** FormData React Native приймає файл як {uri, name, type}; у jest (Node) підміняємо записувачем полів. */
class RecordingFormData {
  parts: { name: string; value: unknown; filename?: string }[] = [];
  append(name: string, value: unknown, filename?: string) {
    this.parts.push({ name, value, filename });
  }
}
const realFormData = global.FormData;
beforeAll(() => {
  (global as any).FormData = RecordingFormData;
});
afterAll(() => {
  global.FormData = realFormData;
});

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let responses: { status: number; body?: unknown; invalidJson?: boolean }[] = [];
let networkDown = false;

beforeEach(() => {
  calls = [];
  responses = [];
  networkDown = false;
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (networkDown) throw new TypeError('Network request failed');
    const r = responses.shift() ?? { status: 404, body: { error: 'not stubbed' } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.invalidJson) throw new SyntaxError('Unexpected token <');
        return r.body;
      },
    } as Response;
  });
});

describe('статуси запитів (як у веб-кабінеті)', () => {
  test('українські назви статусів, регістр не важливий', () => {
    expect(statusLabel('NEW')).toBe('Новий');
    expect(statusLabel('approved')).toBe('Підтверджений');
    expect(statusLabel('CANCELED')).toBe('Скасований');
    expect(statusLabel('CANCELLED')).toBe('Скасований');
    expect(statusLabel('EXPIRED')).toBe('Строк минув');
    expect(statusLabel('SOMETHING')).toBe('SOMETHING');
    expect(statusLabel(undefined)).toBe('');
    expect(Object.keys(PERSON_REQUEST_STATUSES)).toEqual(
      ['NEW', 'APPROVED', 'SIGNED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED']);
  });

  test('продовжити — лише NEW; скасувати — NEW і APPROVED', () => {
    expect(canContinue('NEW')).toBe(true);
    expect(canContinue('new')).toBe(true);
    expect(canContinue('APPROVED')).toBe(false);
    expect(canReject('NEW')).toBe(true);
    expect(canReject('APPROVED')).toBe(true);
    for (const s of ['SIGNED', 'REJECTED', 'CANCELLED', 'EXPIRED', null]) {
      expect(canReject(s)).toBe(false);
      expect(canContinue(s)).toBe(false);
    }
  });

  test('ПІБ пацієнта із запиту', () => {
    expect(personFullName({ last_name: 'Іванов', first_name: 'Петро', second_name: 'Миколайович' })).toBe('Іванов Петро Миколайович');
    expect(personFullName({ last_name: 'Іванов', first_name: 'Петро', second_name: null })).toBe('Іванов Петро');
    expect(personFullName(null)).toBe('');
  });
});

describe('документи запиту', () => {
  test('показуються лише незавантажені документи', () => {
    const details = {
      data: { id: '1', status: 'NEW' },
      urgent: { documents: [
        { type: 'PASSPORT', is_uploaded: false, url: 'https://storage/1' },
        { type: 'BIRTH_CERTIFICATE', is_uploaded: true, url: 'https://storage/2' },
        { type: 'TAX_ID', url: 'https://storage/3' },
      ] },
    };
    expect(pendingDocuments(details).map((d) => d.type)).toEqual(['PASSPORT', 'TAX_ID']);
    expect(pendingDocuments({ data: { id: '1' } })).toEqual([]);
    expect(pendingDocuments({ urgent: null })).toEqual([]);
    expect(pendingDocuments(null)).toEqual([]);
  });

  test('інформаційний текст залежить від наявності документів', () => {
    expect(documentsInfo(2)).toBe('Завантажте електронні копії документів (PDF, JPG, PNG, BMP, до 20 МБ):');
    expect(documentsInfo(0)).toBe('Документи не потрібні або вже завантажені.');
  });

  test('назви типів документів з довідника DOCUMENT_TYPE (лише активні значення)', () => {
    const values = parseDictionary({ data: [{ name: 'DOCUMENT_TYPE', values: [
      { code: 'PASSPORT', description: 'Паспорт', is_active: true },
      { code: 'OLD', description: 'Застарілий', is_active: false },
      { code: 'NATIONAL_ID', description: 'ID-картка' },
    ] }] });
    expect(values.map((v) => v.code)).toEqual(['PASSPORT', 'NATIONAL_ID']);
    expect(documentTypeLabel(values, 'PASSPORT')).toBe('Паспорт');
    expect(documentTypeLabel(values, 'OLD')).toBe('OLD');
    expect(parseDictionary(null)).toEqual([]);
    expect(parseDictionary({ data: [] })).toEqual([]);
    expect(parseDictionary({ data: [{ values: { PASSPORT: 'Паспорт' } }] })).toEqual([]);
  });

  test('завершення завантаження копій документів', () => {
    expect(documentsCompleteResult({ data: [{ type: 'PASSPORT' }] })).toEqual(
      { done: false, message: 'Ще не всі документи завантажено. Завантажте решту документів.' });
    expect(documentsCompleteResult({ data: [] })).toEqual({ done: true, message: 'Копії документів передано до ЕСОЗ.' });
    expect(documentsCompleteResult({})).toEqual({ done: true, message: TEXTS.documentsSent });
  });
});

describe('вимоги до файлів п.3.6.1', () => {
  test('дозволені формати PDF, JPG, PNG, BMP', () => {
    for (const name of ['scan.pdf', 'photo.JPG', 'photo.jpeg', 'img.png', 'img.bmp']) {
      expect(validateDocumentFile(name, 1000)).toBeNull();
    }
    expect(validateDocumentFile('doc.docx', 1000)).toBe('Дозволені формати: PDF, JPG, PNG, BMP');
    expect(validateDocumentFile('noext', 1000)).toBe('Дозволені формати: PDF, JPG, PNG, BMP');
    expect(validateDocumentFile('archive.pdf.zip', 1000)).toBe('Дозволені формати: PDF, JPG, PNG, BMP');
  });

  test('розмір до 20 МБ', () => {
    expect(validateDocumentFile('scan.pdf', DOCUMENT_MAX_BYTES)).toBeNull();
    expect(validateDocumentFile('scan.pdf', DOCUMENT_MAX_BYTES + 1)).toBe('Файл більший за 20 МБ');
    expect(validateDocumentFile('scan.pdf', undefined)).toBeNull();
  });

  test('заборонені символи в назві', () => {
    for (const ch of ['Ы', 'ъ', 'Э', 'ё', '@', '%', '&', '$', '^', '#']) {
      expect(validateDocumentFile(`scan${ch}.pdf`, 10)).toBe('Назва файлу містить заборонені символи');
    }
    expect(validateDocumentFile('Паспорт_сторінка 1.pdf', 10)).toBeNull();
  });

  test('назва без розширення доповнюється за MIME-типом', () => {
    expect(uploadFileName('document', 'application/pdf')).toBe('document.pdf');
    expect(uploadFileName('IMG_0001', 'image/jpeg')).toBe('IMG_0001.jpg');
    expect(uploadFileName('picture', 'image/x-ms-bmp')).toBe('picture.bmp');
    expect(uploadFileName('scan.pdf', 'image/png')).toBe('scan.pdf');
    expect(uploadFileName('unknown', 'text/plain')).toBe('unknown');
    expect(uploadFileName('unknown')).toBe('unknown');
  });

  test('MIME-тип визначається за розширенням', () => {
    expect(mimeTypeFor('a.PDF')).toBe('application/pdf');
    expect(mimeTypeFor('a.jpg')).toBe('image/jpeg');
    expect(mimeTypeFor('a.bmp')).toBe('image/bmp');
    expect(mimeTypeFor('a', 'image/png')).toBe('image/png');
    expect(mimeTypeFor('a')).toBe('application/octet-stream');
  });

  test('prepareUpload: перевірка і нормалізація обраного файлу', () => {
    expect(prepareUpload({ uri: 'file:///c/1', name: 'doc', size: 10, mimeType: 'application/pdf' })).toEqual({
      file: { uri: 'file:///c/1', name: 'doc.pdf', size: 10, mimeType: 'application/pdf' }, error: null,
    });
    expect(prepareUpload({ uri: 'file:///c/2', name: 'big.png', size: DOCUMENT_MAX_BYTES + 1 })).toEqual(
      { file: null, error: 'Файл більший за 20 МБ' });
    expect(prepareUpload({ uri: 'file:///c/3', name: 'notes.txt', size: 1, mimeType: 'text/plain' }).error).toBe(
      'Дозволені формати: PDF, JPG, PNG, BMP');
  });
});

describe('вибір файлу', () => {
  const getDocumentAsync = DocumentPicker.getDocumentAsync as jest.Mock;

  test('фільтр форматів і один файл', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/p.pdf', name: 'p.pdf', size: 123, mimeType: 'application/pdf', lastModified: 1 }],
    });
    await expect(pickDocumentFile()).resolves.toEqual(
      { uri: 'file:///cache/p.pdf', name: 'p.pdf', size: 123, mimeType: 'application/pdf', file: undefined });
    expect(getDocumentAsync).toHaveBeenCalledWith({ type: DOCUMENT_PICKER_TYPES, copyToCacheDirectory: true, multiple: false });
    expect(DOCUMENT_PICKER_TYPES).toEqual(expect.arrayContaining(['application/pdf', 'image/jpeg', 'image/png', 'image/bmp']));
  });

  test('скасування вибору', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickDocumentFile()).resolves.toBeNull();
  });
});

describe('запити до BFF', () => {
  test('маршрути запиту на зміну даних з екрануванням id', () => {
    expect(personRequestPath('abc')).toBe('/ehealth/person-requests/abc');
    expect(personRequestPath('a/b?c', '/sign-content')).toBe('/ehealth/person-requests/a%2Fb%3Fc/sign-content');
    expect(personRequestPath('abc', '/complete')).toBe('/ehealth/person-requests/abc/complete');
    expect(personRequestPath('abc', '/reject')).toBe('/ehealth/person-requests/abc/reject');
    expect(personRequestPath('abc', '/documents/upload')).toBe('/ehealth/person-requests/abc/documents/upload');
  });

  test('тіло Complete — signed_content, як у веб-кабінеті', () => {
    expect(completePayload('U0lHTkVE')).toEqual({ signed_content: 'U0lHTkVE' });
  });

  test('завантаження копії: multipart type+file, Bearer-токен, базова адреса BFF', async () => {
    responses.push({ status: 200, body: { message: 'Файл завантажено', type: 'PASSPORT' } });
    const result = await uploadDocument('/ehealth/person-requests/R1/documents/upload', 'PASSPORT',
      { uri: 'file:///cache/p.pdf', name: 'p.pdf', mimeType: 'application/pdf' }, 'SESSION');
    expect(result).toEqual({ message: 'Файл завантажено', type: 'PASSPORT' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://pis.test/api/ehealth/person-requests/R1/documents/upload');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer SESSION');
    expect(headers.Accept).toBe('application/json');
    // межу multipart встановлює fetch — власний Content-Type не задається
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(RecordingFormData);
    expect((init.body as unknown as RecordingFormData).parts).toEqual([
      { name: 'type', value: 'PASSPORT', filename: undefined },
      { name: 'file', value: { uri: 'file:///cache/p.pdf', name: 'p.pdf', type: 'application/pdf' }, filename: undefined },
    ]);
  });

  test('веб-платформа: передається об’єкт File з назвою', async () => {
    responses.push({ status: 200, body: {} });
    const blob = { size: 3 } as unknown as Blob;
    await uploadDocument('/ehealth/documents/upload', 'PASSPORT', { uri: 'blob:x', name: 'x.png', file: blob }, 'S');
    expect((calls[0].init.body as unknown as RecordingFormData).parts[1]).toEqual({ name: 'file', value: blob, filename: 'x.png' });
  });

  test('без токена заголовок Authorization не передається', async () => {
    responses.push({ status: 200, body: {} });
    await uploadDocument('/ehealth/documents/upload', 'PASSPORT', { uri: 'file:///x.png', name: 'x.png' }, null);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/documents/upload');
  });

  test('помилка сервера — ApiError з текстом від BFF; 401 — недійсна сесія', async () => {
    responses.push({ status: 400, body: { error: 'Для цього типу документа завантаження не очікується' } });
    const p = uploadDocument('/ehealth/documents/upload', 'PASSPORT', { uri: 'file:///x.pdf', name: 'x.pdf' }, 'S');
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toThrow('Для цього типу документа завантаження не очікується');

    responses.push({ status: 401, body: { error: 'Потрібна авторизація' } });
    const e = await uploadDocument('/ehealth/documents/upload', 'PASSPORT', { uri: 'file:///x.pdf', name: 'x.pdf' }, 'S')
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).unauthorized).toBe(true);
  });

  test('перевищення ліміту сервера (413 без JSON) і відсутність мережі', async () => {
    responses.push({ status: 413, invalidJson: true });
    await expect(uploadDocument('/ehealth/documents/upload', 'PASSPORT', { uri: 'file:///x.pdf', name: 'x.pdf' }, 'S'))
      .rejects.toThrow('Файл більший за 20 МБ');
    networkDown = true;
    await expect(uploadDocument('/ehealth/documents/upload', 'PASSPORT', { uri: 'file:///x.pdf', name: 'x.pdf' }, 'S'))
      .rejects.toThrow('Немає з’єднання із сервером');
  });
});
