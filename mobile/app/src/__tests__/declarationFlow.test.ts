/* eslint-disable import/first -- jest.mock має стояти до імпортів модулів, які він підміняє */
jest.mock('expo-constants', () => ({ expoConfig: { extra: { pisApiBase: 'https://pis.test', ehealthEnv: 'pis-app' } } }));

import { ApiError } from '../lib/api';
import {
  EMPTY_FILTERS, EMPTY_SCOPE, MSG_NO_CONTRACT, MSG_OVERLIMIT, PAGE_SIZE, SIGN_DONE, buildDoctorQuery,
  chooseDoctorConfirmations, createDeclarationRequest, createRequestBody, declarationsText, dictLabel, educationLines,
  errorMessage, fetchDeclarationRequest, fetchDeclarationRequests, fetchDivisions, fetchDoctor, fetchSignContent,
  fullName, genderAgeText, loadDictionary, nearLimitWarning, nextOffset, parsePlacesLeft, placesLeft,
  qualificationLines, rejectDeclarationRequest, requestActions, requestFormContent, requestStatusLabel,
  scopeForDivision, scopeForDivisionRow, scopeForLegalEntity, searchDoctors, signDeclarationRequest, signRequestBody,
  signResultMessage, specialityLines, specialityOptions, splitPage, toRequestRow, withViewport,
  type DoctorDetails, type DoctorRow,
} from '../lib/declarationFlow';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let responses: { status: number; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 404, body: { error: 'not stubbed' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  });
});

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

const row = (over: Partial<DoctorRow> = {}): DoctorRow => ({
  employee_id: 'E1', division_id: 'D1', legal_entity_id: 'L1', last_name: 'Іваненко', first_name: 'Олена',
  second_name: 'Петрівна', gender: 'FEMALE', age: 45, speciality: 'FAMILY_DOCTOR', division_name: 'Амбулаторія №1',
  legal_entity_name: 'КНП ЦПМСД', address_text: 'м. Київ, вул. Хрещатик, 1', declarations_limit: 1800,
  declarations_count: 1000, in_contract: true, overlimit: false, ...over,
});

describe('пошук лікаря', () => {
  test('параметри запиту — ті самі й у тому ж порядку, що у веб-кабінеті', () => {
    expect(buildDoctorQuery(EMPTY_FILTERS, EMPTY_SCOPE, 0)).toBe(
      'name=&speciality=&gender=&legal_entity=&division=&address=&overlimit=&in_contract=&limit=26&offset=0');
    const q = buildDoctorQuery({
      name: '  Іваненко Олена ', speciality: 'THERAPIST', gender: 'FEMALE', legalEntity: ' ЦПМСД ', division: 'Амб',
      address: 'Київ', overlimit: 'false', inContract: 'true',
    }, { legalEntityId: 'L1', divisionId: 'D 2', label: 'x' }, 25);
    const params = q.split('&').map((p) => p.split('=').map(decodeURIComponent));
    expect(params).toEqual([
      ['name', 'Іваненко Олена'], ['speciality', 'THERAPIST'], ['gender', 'FEMALE'], ['legal_entity', 'ЦПМСД'],
      ['division', 'Амб'], ['address', 'Київ'], ['overlimit', 'false'], ['in_contract', 'true'], ['limit', '26'],
      ['offset', '25'], ['legal_entity_id', 'L1'], ['division_id', 'D 2'],
    ]);
  });

  test('сторінки: limit = 26, наступна є лише коли рядків більше за 25', () => {
    expect(nextOffset(50, 0)).toBe(0);
    expect(nextOffset(25, 1)).toBe(50);
    expect(nextOffset(25, -1)).toBe(0);
    expect(nextOffset(0, -1)).toBe(0);
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => i);
    expect(splitPage(rows)).toEqual({ rows: rows.slice(0, PAGE_SIZE), hasNext: true });
    expect(splitPage(rows.slice(0, PAGE_SIZE))).toEqual({ rows: rows.slice(0, PAGE_SIZE), hasNext: false });
  });

  test('обмеження закладом і МНП', () => {
    const le = scopeForLegalEntity(row());
    expect(le).toEqual({ legalEntityId: 'L1', divisionId: null, label: 'Заклад: КНП ЦПМСД' });
    expect(scopeForDivision(le, row({ division_id: 'D9', division_name: 'Філія' })))
      .toEqual({ legalEntityId: 'L1', divisionId: 'D9', label: 'Місце надання послуг: Філія' });
    expect(scopeForDivisionRow(EMPTY_SCOPE, { id: 'D3', name: 'Пункт' }))
      .toEqual({ legalEntityId: null, divisionId: 'D3', label: 'Місце надання послуг: Пункт' });
  });

  test('тексти картки лікаря', () => {
    const genders = [{ code: 'FEMALE', description: 'Жіноча' }];
    expect(fullName(row())).toBe('Іваненко Олена Петрівна');
    expect(fullName({ last_name: 'Коваль', first_name: 'Іван' })).toBe('Коваль Іван');
    expect(genderAgeText(row(), genders)).toBe('Жіноча, 45 р.');
    expect(genderAgeText(row({ age: null }), [])).toBe('FEMALE');
    expect(declarationsText(null, 5)).toBe('—');
    expect(declarationsText(1800, 1000)).toBe('1000 / 1800');
    expect(declarationsText(1800, null)).toBe('0 / 1800');
    expect(dictLabel(undefined, null)).toBe('—');
  });

  test('спеціальності первинної допомоги з довідника, з підписом за замовчуванням', () => {
    const opts = specialityOptions({ SPECIALITY_TYPE: [{ code: 'THERAPIST', description: 'Лікар-терапевт' }] });
    expect(opts.map((o) => o.value)).toEqual(['', 'FAMILY_DOCTOR', 'THERAPIST', 'PEDIATRICIAN']);
    expect(opts[0].label).toBe('Усі доступні');
    expect(opts[2].label).toBe('Лікар-терапевт');
    expect(opts[3].label).toBe('Педіатр');
  });

  test('відомості про лікаря: спеціальності, освіта, кваліфікації', () => {
    const d: DoctorDetails = {
      employee_id: 'E1',
      specialities: [{ speciality: 'FAMILY_DOCTOR', speciality_officio: true, level: 'FIRST' }, { speciality: 'THERAPIST' }],
      educations: [{ degree: 'MASTER', speciality: 'FAMILY_DOCTOR', institution_name: 'НМУ' }],
      qualifications: [{ type: 'SPECIALIZATION', speciality: 'THERAPIST' }],
    };
    const dicts = {
      SPECIALITY_TYPE: [{ code: 'FAMILY_DOCTOR', description: 'Сімейний лікар' }, { code: 'THERAPIST', description: 'Терапевт' }],
      SPECIALITY_LEVEL: [{ code: 'FIRST', description: 'Перша категорія' }],
      EDUCATION_DEGREE: [{ code: 'MASTER', description: 'Магістр' }],
      QUALIFICATION_TYPE: [{ code: 'SPECIALIZATION', description: 'Спеціалізація' }],
    };
    expect(specialityLines(d, dicts)).toEqual(['Сімейний лікар (основна), Перша категорія', 'Терапевт']);
    expect(educationLines(d, dicts)).toEqual(['Магістр — Сімейний лікар, НМУ']);
    expect(qualificationLines(d, dicts)).toEqual(['Спеціалізація — Терапевт']);
    expect(specialityLines({ employee_id: 'E2' }, {})).toEqual([]);
  });
});

describe('вибір лікаря і запит на декларацію', () => {
  test('попередження: спершу ліміт, потім відсутність договору', () => {
    expect(chooseDoctorConfirmations(row())).toEqual([]);
    expect(chooseDoctorConfirmations(row({ overlimit: true, in_contract: false }))).toEqual([MSG_OVERLIMIT, MSG_NO_CONTRACT]);
    expect(chooseDoctorConfirmations(row({ in_contract: false }))).toEqual([MSG_NO_CONTRACT]);
  });

  test('тіло запиту — лише employee_id і division_id', () => {
    expect(createRequestBody(row())).toEqual({ employee_id: 'E1', division_id: 'D1' });
  });

  test('попередження «залишилося місць» — лише коли їх від 1 до 19', () => {
    expect(placesLeft(null, 3)).toBeNull();
    expect(placesLeft(100, 95)).toBe(5);
    expect(placesLeft(100, null)).toBe(100);
    expect(nearLimitWarning(5)).toBe('У лікаря залишилося 5 місць до рекомендованого ліміту декларацій.');
    expect(nearLimitWarning(19)).not.toBe('');
    expect(nearLimitWarning(20)).toBe('');
    expect(nearLimitWarning(0)).toBe('');
    expect(nearLimitWarning(null)).toBe('');
    expect(parsePlacesLeft('7')).toBe(7);
    expect(parsePlacesLeft(['3'])).toBe(3);
    expect(parsePlacesLeft(undefined)).toBeNull();
    expect(parsePlacesLeft('abc')).toBeNull();
  });

  test('статуси і дії запиту', () => {
    expect(requestStatusLabel('NEW')).toBe('Новий (очікує підпису)');
    expect(requestStatusLabel('approved')).toBe('Погоджується лікарем');
    expect(requestStatusLabel('UNKNOWN')).toBe('UNKNOWN');
    expect(requestStatusLabel(null)).toBe('—');
    expect(requestActions('NEW')).toEqual({ canSign: true, canReject: true });
    expect(requestActions('APPROVED')).toEqual({ canSign: false, canReject: true });
    expect(requestActions('signed')).toEqual({ canSign: false, canReject: false });
  });

  test('форма показується лише з даними Користувача', () => {
    expect(requestFormContent({ data_to_be_signed: { content: '<p>A</p>', person: { id: 'P' } } })).toBe('<p>A</p>');
    expect(requestFormContent({ content: '<p>B</p>' })).toBe('<p>B</p>');
    expect(requestFormContent({ data_to_be_signed: { content: '<p>A</p>' } })).toBeNull();
    expect(requestFormContent({ status: 'SIGNED' })).toBeNull();
    expect(requestFormContent(undefined)).toBeNull();
  });

  test('viewport додається лише якщо його немає', () => {
    expect(withViewport('<p>x</p>')).toBe('<meta name="viewport" content="width=device-width, initial-scale=1"><p>x</p>');
    const own = '<html><head><meta name="viewport" content="width=800"></head></html>';
    expect(withViewport(own)).toBe(own);
  });

  test('підпис: тіло і повідомлення за статусом', () => {
    expect(signRequestBody('U0lHTg==')).toEqual({ signed_content: 'U0lHTg==' });
    expect(signResultMessage({ message: 'Вітаємо з вибором лікаря!' })).toBe('Вітаємо з вибором лікаря!');
    expect(signResultMessage({ message: null })).toBe(SIGN_DONE);
    expect(signResultMessage(undefined)).toBe(SIGN_DONE);
  });

  test('рядок переліку запитів', () => {
    expect(toRequestRow({ id: 'R1', declaration_number: '0000-1', status: 'NEW', start_date: '2026-10-01' })).toEqual({
      id: 'R1', number: '0000-1', statusLabel: 'Новий (очікує підпису)', date: '2026-10-01', openLabel: 'Продовжити', canReject: true,
    });
    expect(toRequestRow({ id: 'R2', status: 'signed', inserted_at: '2026-09-01T10:00:00Z' })).toEqual({
      id: 'R2', number: '—', statusLabel: 'Підписаний', date: '2026-09-01T10:00:00Z', openLabel: 'Деталі', canReject: false,
    });
  });

  test('текст помилки', () => {
    expect(errorMessage(new ApiError('Помилка ЕСОЗ', 422))).toBe('Помилка ЕСОЗ');
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('?')).toBe('Сталася помилка');
  });
});

describe('виклики BFF', () => {
  test('довідник: активні значення, кешування успішної відповіді', async () => {
    responses.push({ status: 200, body: { data: [{ name: 'GENDER', values: [
      { code: 'MALE', description: 'Чоловіча', is_active: true }, { code: 'OLD', description: 'x', is_active: false }] }] } });
    await expect(loadDictionary('GENDER')).resolves.toEqual([{ code: 'MALE', description: 'Чоловіча', is_active: true }]);
    await expect(loadDictionary('GENDER')).resolves.toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/dictionaries?name=GENDER');
  });

  test('довідник: помилка -> порожній перелік без кешування', async () => {
    responses.push({ status: 502, body: { error: 'ЕСОЗ недоступна' } });
    await expect(loadDictionary('SPECIALITY_LEVEL')).resolves.toEqual([]);
    responses.push({ status: 200, body: { data: [{ values: [{ code: 'FIRST', description: 'Перша' }] }] } });
    await expect(loadDictionary('SPECIALITY_LEVEL')).resolves.toHaveLength(1);
  });

  test('пошук лікарів з токеном і поділом на сторінку', async () => {
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => row({ employee_id: `E${i}` }));
    responses.push({ status: 200, body: { data: rows } });
    const page = await searchDoctors('TOKEN', { ...EMPTY_FILTERS, name: 'Іван' }, EMPTY_SCOPE, 0);
    expect(page.rows).toHaveLength(PAGE_SIZE);
    expect(page.hasNext).toBe(true);
    expect(calls[0].url).toBe(`https://pis.test/api/registry/doctors?${buildDoctorQuery({ ...EMPTY_FILTERS, name: 'Іван' }, EMPTY_SCOPE, 0)}`);
    expect(header(calls[0], 'Authorization')).toBe('Bearer TOKEN');
  });

  test('відомості про лікаря і МНП закладу', async () => {
    responses.push({ status: 200, body: { data: { employee_id: 'E/1', warning: null } } });
    await expect(fetchDoctor('T', 'E/1')).resolves.toEqual({ employee_id: 'E/1', warning: null });
    expect(calls[0].url).toBe('https://pis.test/api/registry/doctors/E%2F1');
    responses.push({ status: 200, body: { data: [{ id: 'D1', name: 'Амбулаторія', in_contract: false }] } });
    await expect(fetchDivisions('T', 'L1')).resolves.toEqual([{ id: 'D1', name: 'Амбулаторія', in_contract: false }]);
    expect(calls[1].url).toBe('https://pis.test/api/registry/divisions?legal_entity_id=L1');
  });

  test('МНП: помилка -> порожній перелік, але недійсна сесія пробрасується', async () => {
    responses.push({ status: 500, body: {} });
    await expect(fetchDivisions('T', 'L1')).resolves.toEqual([]);
    responses.push({ status: 401, body: { error: 'Потрібна авторизація' } });
    await expect(fetchDivisions('T', 'L1')).rejects.toMatchObject({ unauthorized: true });
  });

  test('створення запиту: POST з тим самим тілом, що у веб-кабінеті', async () => {
    responses.push({ status: 200, body: { data: { id: 'R1', status: 'NEW', content: '<p>форма</p>' } } });
    await expect(createDeclarationRequest('T', row())).resolves.toMatchObject({ id: 'R1' });
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/declaration-requests');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ employee_id: 'E1', division_id: 'D1' });
  });

  test('створення запиту: помилка валідації сервера', async () => {
    responses.push({ status: 400, body: { error: 'Лікар цієї спеціальності не може обслуговувати пацієнтів вашого віку' } });
    await expect(createDeclarationRequest('T', row())).rejects.toThrow('Лікар цієї спеціальності не може обслуговувати пацієнтів вашого віку');
  });

  test('деталі запиту і перелік запитів', async () => {
    responses.push({ status: 200, body: { data: { id: 'R1', status: 'NEW' }, urgent: {} } });
    await expect(fetchDeclarationRequest('T', 'R1')).resolves.toEqual({ id: 'R1', status: 'NEW' });
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/declaration-requests/R1');
    responses.push({ status: 200, body: { data: [{ id: 'R1', status: 'approved', declaration_number: 'N1' }] } });
    const rows = await fetchDeclarationRequests('T');
    expect(rows[0]).toMatchObject({ id: 'R1', number: 'N1', openLabel: 'Деталі', canReject: true });
    expect(calls[1].url).toBe('https://pis.test/api/ehealth/declaration-requests');
    expect(calls[1].init.method).toBe('GET');
  });

  test('дані для підпису: рядок content без змін і попередження', async () => {
    const content = '{"id":"R1","person":{"patient_signed":true}}';
    responses.push({ status: 200, body: { content, warning: 'У лікаря залишилося 3 місць до рекомендованого ліміту декларацій.' } });
    await expect(fetchSignContent('T', 'R1')).resolves.toEqual({
      content, warning: 'У лікаря залишилося 3 місць до рекомендованого ліміту декларацій.' });
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/declaration-requests/R1/sign-content');
    responses.push({ status: 200, body: { content, warning: null } });
    await expect(fetchSignContent('T', 'R1')).resolves.toEqual({ content, warning: null });
    responses.push({ status: 200, body: {} });
    await expect(fetchSignContent('T', 'R1')).rejects.toThrow('ЕСОЗ не повернула дані для підпису декларації');
    responses.push({ status: 400, body: { error: 'Підписати можна лише запит у статусі NEW' } });
    await expect(fetchSignContent('T', 'R1')).rejects.toThrow('Підписати можна лише запит у статусі NEW');
  });

  test('підпис: PATCH { signed_content } і повідомлення сервера', async () => {
    responses.push({ status: 200, body: { data: { status: 'SIGNED' }, message: 'Вітаємо з вибором лікаря!' } });
    await expect(signDeclarationRequest('T', 'R1', 'U0lHTg==')).resolves.toBe('Вітаємо з вибором лікаря!');
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/declaration-requests/R1/sign');
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ signed_content: 'U0lHTg==' });
    responses.push({ status: 200, body: { data: { status: 'NEW' }, message: null } });
    await expect(signDeclarationRequest('T', 'R1', 'U0lHTg==')).resolves.toBe(SIGN_DONE);
  });

  test('відхилення: PATCH без тіла, як у веб-кабінеті', async () => {
    responses.push({ status: 200, body: { data: { status: 'REJECTED' } } });
    await expect(rejectDeclarationRequest('T', 'R1')).resolves.toBeUndefined();
    expect(calls[0].url).toBe('https://pis.test/api/ehealth/declaration-requests/R1/reject');
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].init.body).toBeUndefined();
    expect(header(calls[0], 'Content-Type')).toBeUndefined();
  });

  test('доступ до ЕСОЗ припинено — ApiError.ehealthRequired', async () => {
    responses.push({ status: 401, body: { error: 'Увійдіть через ЕСОЗ (eHealth), щоб переглянути ці дані', ehealth_required: true } });
    await expect(createDeclarationRequest('T', row())).rejects.toMatchObject({ ehealthRequired: true, unauthorized: false });
  });
});
