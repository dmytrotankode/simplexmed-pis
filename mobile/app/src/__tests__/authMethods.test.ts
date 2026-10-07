/* eslint-disable import/first -- jest.mock має стояти до імпортів модулів, які він підміняє */
jest.mock('expo-constants', () => ({ expoConfig: { extra: { pisApiBase: 'https://pis.test', ehealthEnv: 'pis-app' } } }));

import { ApiError } from '../lib/api';
import {
  type AuthMethod,
  MSG_ALIAS_REQUIRED,
  MSG_CREATED,
  MSG_OTP_REQUIRED,
  MSG_PHONE_FORMAT,
  MSG_SMS_SENT,
  NOTICE_NO_METHODS,
  NOTICE_OFFLINE,
  activeMethods,
  approveAuthMethodRequest,
  authMethodsNotice,
  buildCreatePayload,
  canDeactivate,
  canRename,
  createAuthMethodRequest,
  createOutcome,
  deactivateAuthMethod,
  deactivateConfirmText,
  describeScopes,
  detailRows,
  errorMessage,
  fetchAppDetails,
  fetchApps,
  fetchAuthMethods,
  fetchOwnClientId,
  fetchScopeDescriptions,
  isCurrentClient,
  methodTypeLabel,
  renameAuthMethod,
  resendAuthMethodOtp,
  revokeApp,
  revokeConfirmText,
  scopeDescriptions,
  validateAlias,
  validateOtp,
  validatePhone,
} from '../lib/authMethods';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let responses: { status: number; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 404, body: { error: 'not stubbed' } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError('empty body');
        return r.body;
      },
    } as Response;
  });
});

const body = (i: number) => (calls[i].init.body === undefined ? undefined : JSON.parse(String(calls[i].init.body)));
const headers = (i: number) => calls[i].init.headers as Record<string, string>;

const otp: AuthMethod = { id: 'm1', type: 'OTP', phone_number: '+380501112233', alias: 'мій', is_active: true, started_at: '2024-01-02 10:00:00' };
const offline: AuthMethod = { id: 'm2', type: 'OFFLINE', is_active: true };
const third: AuthMethod = { id: 'm3', type: 'THIRD_PERSON', alias: 'чоловік', is_active: true, confidant_person: { name: 'Петров А.А.' } };

describe('перелік методів (п.3.9.4)', () => {
  test('неактивні методи не показуються', () => {
    expect(activeMethods([otp, { ...offline, is_active: false }, third]).map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(activeMethods(undefined)).toEqual([]);
  });

  test('повідомлення п.3.9.4.2 і 3.9.4.3 — тексти ТВ', () => {
    expect(authMethodsNotice([])).toBe(NOTICE_NO_METHODS);
    expect(NOTICE_NO_METHODS).toBe('Необхідно внести новий метод автентифікації! Це допоможе забезпечити зручність отримання '
      + 'електронних медичних сервісів та вищий контроль Вами доступу до інформації про Вас.');
    expect(authMethodsNotice([otp, offline])).toBe(NOTICE_OFFLINE);
    expect(NOTICE_OFFLINE.startsWith('Додайте новий метод автентифікації з використанням номеру телефону.')).toBe(true);
    expect(authMethodsNotice([otp])).toBeNull();
  });

  test('типи і дозволені дії', () => {
    expect(methodTypeLabel('OTP')).toBe('SMS (OTP)');
    expect(methodTypeLabel('OFFLINE')).toBe('Офлайн (документи)');
    expect(methodTypeLabel('THIRD_PERSON')).toBe('Третя особа');
    expect(methodTypeLabel('NA')).toBe('NA');
    expect(canRename(otp)).toBe(true);
    expect(canRename(third)).toBe(false);
    expect(canRename({ ...otp, is_active: false })).toBe(false);
    expect(canDeactivate(otp)).toBe(true);
    expect(canDeactivate(offline)).toBe(false);
  });

  test('підтвердження деактивації попереджає про останній метод', () => {
    expect(deactivateConfirmText(otp, [otp, third])).toContain('«мій»');
    expect(deactivateConfirmText(otp, [otp, third])).not.toContain('останній');
    expect(deactivateConfirmText(otp, [otp])).toContain('останній активний метод');
    expect(deactivateConfirmText({ ...otp, alias: null }, [otp, third])).toContain('«+380501112233»');
  });

  test('усі атрибути для перегляду, вкладені — через крапку', () => {
    const rows = detailRows({ ...third, phones: [{ number: '+380' }], is_active: false, ended_at: null });
    expect(rows).toContainEqual({ key: 'confidant_person.name', label: 'Довірена особа', value: 'Петров А.А.' });
    expect(rows).toContainEqual({ key: 'phones.0.number', label: 'phones.0.number', value: '+380' });
    expect(rows).toContainEqual({ key: 'is_active', label: 'Активний', value: 'Ні' });
    expect(rows).toContainEqual({ key: 'ended_at', label: 'Діє до', value: '—' });
  });
});

describe('додавання методу OTP (п.3.10.3)', () => {
  test('перевірки як у веб-кабінеті', () => {
    expect(validatePhone(' +380501112233 ')).toBeNull();
    expect(validatePhone('0501112233')).toBe(MSG_PHONE_FORMAT);
    expect(validatePhone('+38050111223')).toBe(MSG_PHONE_FORMAT);
    expect(validateOtp('1234')).toBeNull();
    expect(validateOtp('123456')).toBeNull();
    expect(validateOtp('123')).toBe(MSG_OTP_REQUIRED);
    expect(validateOtp('12a4')).toBe(MSG_OTP_REQUIRED);
    expect(validateAlias('  ')).toBe(MSG_ALIAS_REQUIRED);
    expect(validateAlias('дім')).toBeNull();
  });

  test('тіло запиту: номер і назва, порожня назва — null', () => {
    expect(buildCreatePayload(' +380501112233 ', ' мій ')).toEqual({ phone_number: '+380501112233', alias: 'мій' });
    expect(buildCreatePayload('+380501112233', '  ')).toEqual({ phone_number: '+380501112233', alias: null });
  });

  test('COMPLETED — метод створено, інакше потрібен код із SMS', () => {
    expect(createOutcome({ id: 'r1', status: 'completed' })).toEqual({ phase: 'done', message: MSG_CREATED });
    expect(createOutcome({ id: 'r1', status: 'NEW' })).toEqual({ phase: 'otp', requestId: 'r1', message: MSG_SMS_SENT });
  });

  test('створення, підтвердження кодом і повторне надсилання — маршрути BFF', async () => {
    responses.push({ status: 201, body: { data: { id: 'req/1', status: 'NEW' } } });
    await expect(createAuthMethodRequest('T', '+380501112233', '')).resolves.toEqual(
      { phase: 'otp', requestId: 'req/1', message: MSG_SMS_SENT });
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/authentication-method-requests');
    expect(calls[0].init.method).toBe('POST');
    expect(headers(0).Authorization).toBe('Bearer T');
    expect(body(0)).toEqual({ phone_number: '+380501112233', alias: null });

    responses.push({ status: 200, body: {} });
    await resendAuthMethodOtp('T', 'req/1');
    expect(calls[1].url).toBe('https://pis.test/api/ehealth/authentication-method-requests/req%2F1/resend-otp');
    expect(calls[1].init.method).toBe('POST');

    responses.push({ status: 200, body: { data: { status: 'COMPLETED' } } });
    await approveAuthMethodRequest('T', 'req/1', ' 1234 ');
    expect(calls[2].url).toBe('https://pis.test/api/ehealth/authentication-method-requests/req%2F1/approve');
    expect(calls[2].init.method).toBe('PATCH');
    expect(body(2)).toEqual({ verification_code: '1234' });
  });

  test('помилка ЕСОЗ — текст за Додатком 1 від сервера', async () => {
    responses.push({ status: 422, body: { error: 'Цей номер телефону перевищив ліміт для використання в ЕСОЗ. Оберіть інший номер.' } });
    const err = await createAuthMethodRequest('T', '+380501112233', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(errorMessage(err)).toBe('Цей номер телефону перевищив ліміт для використання в ЕСОЗ. Оберіть інший номер.');
  });
});

describe('зміна назви і деактивація (п.3.10.4)', () => {
  test('перелік повертає лише активні методи', async () => {
    responses.push({ status: 200, body: { data: [otp, { ...third, is_active: false }] } });
    await expect(fetchAuthMethods('T')).resolves.toEqual([otp]);
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/person/authentication-methods');
  });

  test('PATCH назви і деактивації', async () => {
    responses.push({ status: 200, body: { data: { ...otp, alias: 'новий' } } });
    await renameAuthMethod('T', 'm1', ' новий ');
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/authentication-methods/m1');
    expect(calls[0].init.method).toBe('PATCH');
    expect(body(0)).toEqual({ alias: 'новий' });

    responses.push({ status: 200, body: { data: { ...otp, is_active: false } } });
    await deactivateAuthMethod('T', 'm1');
    expect(calls[1].url).toBe('https://pis.test/api/ehealth/authentication-methods/m1/deactivate');
    expect(calls[1].init.method).toBe('PATCH');
  });
});

describe('доступи застосунків (п.3.8)', () => {
  const dict = { data: [{ name: 'SCOPES', values: [{ code: 'app:read', description: 'Перегляд доступів' }, { code: 'person:read', description: 'Перегляд даних' }] }] };

  test('скоупи описами з довідника SCOPES, невідомі — кодом', () => {
    const map = scopeDescriptions(dict);
    expect(describeScopes('app:read  person:read other:x', map)).toEqual(['Перегляд доступів', 'Перегляд даних', 'other:x']);
    expect(describeScopes(null, map)).toEqual([]);
    expect(scopeDescriptions(undefined)).toEqual({});
  });

  test('власна ПІС визначається за client_id; попередження п.3.8.2.1', () => {
    const app = { id: 'a1', client_id: 'C1', client_name: 'SimplexMed' };
    expect(isCurrentClient(app, 'C1')).toBe(true);
    expect(isCurrentClient(app, 'C2')).toBe(false);
    expect(isCurrentClient({ id: 'a2' }, null)).toBe(false);
    expect(revokeConfirmText(app, false)).toBe('Відкликати доступ застосунку «SimplexMed» до ваших даних в ЕСОЗ?');
    expect(revokeConfirmText(app, true)).toContain('Для продовження роботи потрібно буде повторно авторизуватися.');
  });

  test('перелік, деталі і відкликання (204 без тіла)', async () => {
    responses.push({ status: 200, body: { data: [{ id: 'a1', client_name: 'X' }] } });
    await expect(fetchApps('T')).resolves.toEqual([{ id: 'a1', client_name: 'X' }]);
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/apps');

    responses.push({ status: 200, body: { data: { id: 'a1', client_name: 'X', scope: 'app:read' } } });
    await expect(fetchAppDetails('T', 'a1')).resolves.toEqual({ id: 'a1', client_name: 'X', scope: 'app:read' });
    expect(calls[1].url).toBe('https://pis.test/api/ehealth/apps/a1');

    responses.push({ status: 204, body: undefined });
    await expect(revokeApp('T', 'a1')).resolves.toBeUndefined();
    expect(calls[2].url).toBe('https://pis.test/api/ehealth/apps/a1');
    expect(calls[2].init.method).toBe('DELETE');
    expect(headers(2).Authorization).toBe('Bearer T');
  });

  test('довідник і конфігурація: недоступність не ламає перелік', async () => {
    responses.push({ status: 200, body: dict });
    await expect(fetchScopeDescriptions()).resolves.toEqual({ 'app:read': 'Перегляд доступів', 'person:read': 'Перегляд даних' });
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/dictionaries?name=SCOPES');
    responses.push({ status: 503, body: { error: 'down' } });
    await expect(fetchScopeDescriptions()).resolves.toEqual({});

    responses.push({ status: 200, body: { client_id: 'C1' } });
    await expect(fetchOwnClientId()).resolves.toBe('C1');
    expect(calls[2].url).toBe('https://pis.test/api/config');
    responses.push({ status: 500, body: {} });
    await expect(fetchOwnClientId()).resolves.toBeNull();
  });
});
