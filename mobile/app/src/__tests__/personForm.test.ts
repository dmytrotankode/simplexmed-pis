/* eslint-disable import/first -- jest.mock має стояти до імпортів модулів, які він підміняє */
jest.mock('expo-constants', () => ({ expoConfig: { extra: { pisApiBase: 'https://pis.test', ehealthEnv: 'pis-app' } } }));

import { ApiError } from '../lib/api';
import {
  type PersonFormValues, ageFromIso, buildPerson, clearDictionaryCache, countrySuggestions, emptyExtras, emptyPersonForm,
  errorSummary, fillFromPerson, formFieldFor, hasPendingDeclarationRequests, isoToDisplay, loadDictionary,
  loadFormDictionaries, mapFieldErrors, maskDate, needsCapacityDoc, normalizePhone, parseDisplayDate, searchSettlements,
  serverFieldErrors, settlementLabel, toIsoDate, validateDates,
} from '../lib/personForm';

const TODAY = new Date(2026, 9, 3); // 03.10.2026

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let routes: Record<string, { status: number; body: unknown }> = {};

beforeEach(() => {
  calls = [];
  routes = {};
  clearDictionaryCache();
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = url.replace('https://pis.test/api', '');
    const r = routes[path] ?? { status: 404, body: { error: 'not stubbed' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  });
});

function filledForm(overrides: Partial<PersonFormValues> = {}): PersonFormValues {
  return {
    ...emptyPersonForm(),
    last_name: ' Шевченко ', first_name: 'Тарас', second_name: 'Григорович', birth_date: '09.03.1990', gender: 'MALE',
    birth_country: 'Україна', birth_settlement: 'Моринці', tax_id: '1234567890', secret: 'Kobzar1814', email: '',
    doc: { type: 'PASSPORT', number: 'АА123456', issued_at: '01.02.2010', issued_by: 'Звенигородський РВ', expiration_date: '' },
    region: 'ЧЕРКАСЬКА', settlement_query: 'Моринці',
    settlement: { id: 'S-1', name: 'Моринці', type: 'VILLAGE', district: 'Звенигородський' },
    addr: { street_type: 'STREET', street: 'Садова', building: '1', apartment: '', zip: '20220' },
    phone: '067 123 45 67', auth_phone: '',
    ec: { last_name: 'Шевченко', first_name: 'Микита', second_name: '', phone: '+380501112233' },
    ...overrides,
  };
}

describe('дати ДД.ММ.РРРР', () => {
  test('маска ставить крапки і обрізає зайве', () => {
    expect(maskDate('0')).toBe('0');
    expect(maskDate('09')).toBe('09');
    expect(maskDate('090')).toBe('09.0');
    expect(maskDate('0903')).toBe('09.03');
    expect(maskDate('09031990')).toBe('09.03.1990');
    expect(maskDate('09.03.19901')).toBe('09.03.1990');
    expect(maskDate('09.03.')).toBe('09.03'); // видалення символу після крапки
    expect(maskDate('ab')).toBe('');
  });

  test('розбір і перетворення', () => {
    expect(parseDisplayDate('09.03.1990')).toBe('1990-03-09');
    expect(parseDisplayDate('29.02.2024')).toBe('2024-02-29');
    expect(parseDisplayDate('29.02.2023')).toBeNull();
    expect(parseDisplayDate('31.04.2020')).toBeNull();
    expect(parseDisplayDate('9.3.1990')).toBeNull();
    expect(parseDisplayDate('')).toBeNull();
    expect(isoToDisplay('1990-03-09')).toBe('09.03.1990');
    expect(isoToDisplay('2010-02-01T00:00:00Z')).toBe('01.02.2010');
    expect(isoToDisplay(null)).toBe('');
    expect(toIsoDate(' 01.02.2010 ')).toBe('2010-02-01');
    expect(toIsoDate('')).toBe('');
    expect(toIsoDate('31.02.2010')).toBe('31.02.2010'); // некоректна — як є, відхилить сервер
  });

  test('вік і документ про дієздатність для 14–17 років (formAge / needsCapacityDoc)', () => {
    expect(ageFromIso('2012-10-03', TODAY)).toBe(14);
    expect(ageFromIso('2012-10-04', TODAY)).toBe(13);
    expect(ageFromIso(null, TODAY)).toBeNull();
    expect(needsCapacityDoc({ birth_date: '03.10.2012' }, TODAY)).toBe(true);
    expect(needsCapacityDoc({ birth_date: '04.10.2012' }, TODAY)).toBe(false);
    expect(needsCapacityDoc({ birth_date: '04.10.2008' }, TODAY)).toBe(true);
    expect(needsCapacityDoc({ birth_date: '03.10.2008' }, TODAY)).toBe(false);
    expect(needsCapacityDoc({ birth_date: '' }, TODAY)).toBe(false);
  });

  test('перевірка формату заповнених дат', () => {
    const values = filledForm({ birth_date: '31.02.1990', cap: { type: '', number: '', issued_at: '1.1.2020', issued_by: '', expiration_date: '' } });
    expect(validateDates(values, false)).toEqual([
      { field: 'birth_date', message: 'Дата народження: вкажіть дату у форматі ДД.ММ.РРРР' },
    ]);
    expect(validateDates(values, true).map((e) => e.field)).toEqual(['birth_date', 'cap.issued_at']);
    expect(validateDates(filledForm(), true)).toEqual([]);
  });
});

test('normalizePhone приводить український номер до +380XXXXXXXXX', () => {
  expect(normalizePhone('067 123 45 67')).toBe('+380671234567');
  expect(normalizePhone('+38 (067) 123-45-67')).toBe('+380671234567');
  expect(normalizePhone('80671234567')).toBe('+380671234567');
  expect(normalizePhone('+380671234567')).toBe('+380671234567');
  expect(normalizePhone('12 34')).toBe('1234');
  expect(normalizePhone('тел. 067')).toBe('тел. 067');
  expect(normalizePhone('  ')).toBe('');
});

describe('buildPerson (collectPerson)', () => {
  test('реєстрація: структура запиту як у веб', () => {
    const person = buildPerson(filledForm(), emptyExtras(), { withAuthMethod: true, today: TODAY });
    expect(person).toEqual({
      first_name: 'Тарас', last_name: 'Шевченко', second_name: 'Григорович', birth_date: '1990-03-09',
      birth_country: 'Україна', birth_settlement: 'Моринці', gender: 'MALE', email: '', no_tax_id: false,
      tax_id: '1234567890', secret: 'Kobzar1814', unzr: '',
      documents: [{ type: 'PASSPORT', number: 'АА123456', issued_at: '2010-02-01', issued_by: 'Звенигородський РВ', expiration_date: '' }],
      addresses: [{
        type: 'RESIDENCE', country: 'UA', area: 'ЧЕРКАСЬКА', region: 'Звенигородський', settlement: 'Моринці',
        settlement_type: 'VILLAGE', settlement_id: 'S-1', street_type: 'STREET', street: 'Садова', building: '1',
        apartment: '', zip: '20220',
      }],
      phones: [{ type: 'MOBILE', number: '+380671234567' }],
      preferred_way_communication: 'phone',
      emergency_contact: { first_name: 'Микита', last_name: 'Шевченко', second_name: '', phones: [{ type: 'MOBILE', number: '+380501112233' }] },
      // Телефон автентифікації не вказано — використовується мобільний
      authentication_methods: [{ type: 'OTP', phone_number: '+380671234567' }],
    });
  });

  test('окремий телефон автентифікації; без методу — для зміни даних', () => {
    const values = filledForm({ auth_phone: '0509998877' });
    expect(buildPerson(values, emptyExtras(), { withAuthMethod: true, today: TODAY }).authentication_methods)
      .toEqual([{ type: 'OTP', phone_number: '+380509998877' }]);
    expect(buildPerson(values, emptyExtras(), { withAuthMethod: false, today: TODAY })).not.toHaveProperty('authentication_methods');
  });

  test('відмова від РНОКПП очищає РНОКПП; без телефону — порожній перелік; без населеного пункту — порожні поля', () => {
    const person = buildPerson(filledForm({ no_tax_id: true, phone: '', settlement: null }), emptyExtras(),
      { withAuthMethod: false, today: TODAY });
    expect(person.no_tax_id).toBe(true);
    expect(person.tax_id).toBe('');
    expect(person.phones).toEqual([]);
    expect(person.addresses[0]).toMatchObject({ region: '', settlement: '', settlement_type: '', settlement_id: '' });
  });

  test('14–17 років: другим іде документ про дієздатність', () => {
    const values = filledForm({
      birth_date: '01.01.2011',
      cap: { type: 'LEGAL_CAPACITY_CERTIFICATE', number: '77', issued_at: '01.06.2026', issued_by: '', expiration_date: '' },
    });
    const docs = buildPerson(values, emptyExtras(), { withAuthMethod: true, today: TODAY }).documents;
    expect(docs).toHaveLength(2);
    expect(docs[1]).toEqual({ type: 'LEGAL_CAPACITY_CERTIFICATE', number: '77', issued_at: '2026-06-01', issued_by: '', expiration_date: '' });
  });
});

describe('fillFromPerson (fillPersonForm)', () => {
  const person = {
    first_name: 'Тарас', last_name: 'Шевченко', birth_date: '1990-03-09', gender: 'MALE', birth_country: 'Україна',
    birth_settlement: 'Моринці', tax_id: '1234567890', no_tax_id: false, unzr: '19900309-12345', secret: 'Kobzar1814',
    email: 't@example.com', preferred_way_communication: 'email',
    documents: [
      { type: 'BIRTH_CERTIFICATE', number: 'I-СВ 1', issued_at: '1990-04-01' },
      { type: 'PASSPORT', number: 'АА123456', issued_at: '2010-02-01', issued_by: 'РВ', expiration_date: '2030-01-01' },
    ],
    addresses: [
      { type: 'REGISTRATION', country: 'UA', area: 'КИЇВ', settlement: 'Київ', settlement_id: 'K', settlement_type: 'CITY' },
      { id: 'A-1', type: 'RESIDENCE', country: 'UA', area: 'ЧЕРКАСЬКА', region: 'Звенигородський', settlement: 'Моринці',
        settlement_type: 'VILLAGE', settlement_id: 'S-1', street: 'Садова', building: '1', zip: '20220' },
    ],
    phones: [{ type: 'LANDLINE', number: '+380441112233' }, { type: 'MOBILE', number: '+380671234567' }],
    emergency_contact: { first_name: 'Микита', last_name: 'Шевченко', phones: [{ type: 'MOBILE', number: '+380501112233' }] },
  };

  test('заповнює форму, зберігає непоказані дані і блокує РНОКПП/УНЗР', () => {
    const { values, extras, locks } = fillFromPerson(person, TODAY);
    expect(values).toMatchObject({
      first_name: 'Тарас', birth_date: '09.03.1990', preferred_way_communication: 'email', tax_id: '1234567890',
      unzr: '19900309-12345', phone: '+380671234567', region: 'ЧЕРКАСЬКА', settlement_query: 'Моринці',
      settlement: { id: 'S-1', name: 'Моринці', type: 'VILLAGE', district: 'Звенигородський' },
      addr: { street_type: '', street: 'Садова', building: '1', apartment: '', zip: '20220' },
      ec: { first_name: 'Микита', last_name: 'Шевченко', second_name: '', phone: '+380501112233' },
    });
    expect(values.doc).toEqual({ type: 'BIRTH_CERTIFICATE', number: 'I-СВ 1', issued_at: '01.04.1990', issued_by: '', expiration_date: '' });
    expect(values.cap).toEqual({ type: '', number: '', issued_at: '', issued_by: '', expiration_date: '' });
    expect(extras.documents).toEqual([person.documents[1]]);
    expect(extras.addresses).toEqual([person.addresses[0]]);
    expect(extras.phones).toEqual([person.phones[0]]);
    expect(locks).toEqual({ taxId: true, unzr: true });

    // Зворотне збирання: непоказані документи/адреси/телефони і атрибути адреси проживання не губляться
    const rebuilt = buildPerson(values, extras, { withAuthMethod: false, today: TODAY });
    expect(rebuilt.documents).toHaveLength(2);
    expect(rebuilt.documents[1]).toBe(person.documents[1]);
    expect(rebuilt.addresses[0]).toMatchObject({ id: 'A-1', type: 'RESIDENCE', settlement_id: 'S-1' });
    expect(rebuilt.addresses[1]).toBe(person.addresses[0]);
    expect(rebuilt.phones).toEqual([{ type: 'MOBILE', number: '+380671234567' }, person.phones[0]]);
  });

  test('14–17 років: другий документ потрапляє в поля дієздатності', () => {
    const teen = { ...person, birth_date: '2011-01-01', documents: [
      { type: 'PASSPORT', number: 'АА1', issued_at: '2025-02-01' },
      { type: 'LEGAL_CAPACITY_CERTIFICATE', number: 'ДЗ-1', issued_at: '2026-01-01' },
      { type: 'TAX_ID', number: '1' },
    ] };
    const { values, extras } = fillFromPerson(teen, TODAY);
    expect(values.doc.number).toBe('АА1');
    expect(values.cap).toMatchObject({ type: 'LEGAL_CAPACITY_CERTIFICATE', number: 'ДЗ-1', issued_at: '01.01.2026' });
    expect(extras.documents).toEqual([{ type: 'TAX_ID', number: '1' }]);
  });

  test('порожній запис ЕСОЗ', () => {
    const { values, extras, locks } = fillFromPerson({}, TODAY);
    expect(values.settlement).toBeNull();
    expect(values.preferred_way_communication).toBe('');
    expect(extras).toEqual({ documents: [], addresses: [], phones: [], residence: {} });
    expect(locks).toEqual({ taxId: false, unzr: false });
  });
});

describe('помилки полів від сервера', () => {
  test('serverFieldErrors читає 422 {fields}', () => {
    const e = new ApiError('Перевірте дані форми реєстрації', 422, {
      fields: [{ field: 'tax_id', message: 'РНОКПП: 10 цифр або позначка про відмову від РНОКПП' }, { field: 'x' }],
    });
    expect(serverFieldErrors(e)).toEqual([{ field: 'tax_id', message: 'РНОКПП: 10 цифр або позначка про відмову від РНОКПП' }]);
    expect(serverFieldErrors(new ApiError('Помилка', 400, {}))).toBeNull();
    expect(serverFieldErrors(new Error('x'))).toBeNull();
  });

  test('відповідність полів сервера полям форми', () => {
    const ctx = { capacityShown: true, hasPhone: true };
    expect(formFieldFor('secret', ctx)).toBe('secret');
    expect(formFieldFor('documents', ctx)).toBe('documents');
    expect(formFieldFor('documents[0].issued_at', ctx)).toBe('doc.issued_at');
    expect(formFieldFor('documents[1].number', ctx)).toBe('cap.number');
    expect(formFieldFor('documents[1].number', { ...ctx, capacityShown: false })).toBeNull();
    expect(formFieldFor('documents[2].expiration_date', ctx)).toBeNull();
    expect(formFieldFor('addresses[0].area', ctx)).toBe('region');
    expect(formFieldFor('addresses[0].settlement_id', ctx)).toBe('settlement');
    expect(formFieldFor('addresses[1].settlement', ctx)).toBeNull();
    expect(formFieldFor('phones[0]', ctx)).toBe('phone');
    expect(formFieldFor('phones[0]', { ...ctx, hasPhone: false })).toBeNull();
    expect(formFieldFor('authentication_methods', ctx)).toBe('auth_phone');
    expect(formFieldFor('emergency_contact', ctx)).toBe('ec');
    expect(formFieldFor('emergency_contact.phones', ctx)).toBe('ec.phone');
    expect(formFieldFor('person', ctx)).toBeNull();
  });

  test('mapFieldErrors групує повідомлення і зберігає повний перелік', () => {
    const { byField, messages } = mapFieldErrors([
      { field: 'addresses[0].settlement', message: "Адреса: населений пункт — обов'язково" },
      { field: 'addresses[0].settlement_type', message: "Адреса: тип населеного пункту — обов'язково" },
      { field: 'documents[3].expiration_date', message: 'Документ: строк дії сплив або дата некоректна' },
      { field: 'birth_date', message: 'Самостійна реєстрація можлива з 14 років' },
    ], { capacityShown: false, hasPhone: true });
    expect(byField).toEqual({
      settlement: "Адреса: населений пункт — обов'язково\nАдреса: тип населеного пункту — обов'язково",
      birth_date: 'Самостійна реєстрація можлива з 14 років',
    });
    expect(messages).toHaveLength(4);
    expect(errorSummary(messages)).toMatch(/^• Адреса: населений пункт/);
    expect(errorSummary(['Одна помилка'])).toBe('Одна помилка');
    expect(errorSummary([])).toBeNull();
  });
});

test('попередження про запити на декларацію NEW/APPROVED (п.3.10.1.5)', () => {
  expect(hasPendingDeclarationRequests([{ status: 'signed' }, { status: 'approved' }])).toBe(true);
  expect(hasPendingDeclarationRequests([{ status: 'NEW' }])).toBe(true);
  expect(hasPendingDeclarationRequests([{ status: 'REJECTED' }, {}])).toBe(false);
});

describe('довідники і адреси ЕСОЗ', () => {
  test('loadDictionary: активні значення, кеш; порожня відповідь не кешується', async () => {
    routes['/ehealth/dictionaries?name=GENDER'] = { status: 200, body: { data: [{ name: 'GENDER', values: [
      { code: 'MALE', description: 'Чоловік' }, { code: 'OTHER', description: 'Інше', is_active: false },
    ] }] } };
    expect(await loadDictionary('GENDER')).toEqual([{ code: 'MALE', description: 'Чоловік' }]);
    await loadDictionary('GENDER');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers).not.toHaveProperty('Authorization');

    routes['/ehealth/dictionaries?name=COUNTRY'] = { status: 200, body: { data: [] } };
    expect(await loadDictionary('COUNTRY', 'TOKEN')).toEqual([]);
    await loadDictionary('COUNTRY', 'TOKEN');
    expect(calls).toHaveLength(3);
    expect((calls[2].init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
  });

  test('loadFormDictionaries: типи документів, запасний довідник статі, області за абеткою', async () => {
    routes['/ehealth/dictionaries?name=DOCUMENT_TYPE'] = { status: 200, body: { data: [{ values: [
      { code: 'PASSPORT', description: 'Паспорт' }, { code: 'LEGAL_CAPACITY_CERTIFICATE', description: 'Свідоцтво' },
    ] }] } };
    routes['/ehealth/dictionaries?name=SETTLEMENT_TYPE'] = { status: 200, body: { data: [{ values: [{ code: 'CITY', description: 'місто' }] }] } };
    routes['/ehealth/dictionaries?name=COUNTRY'] = { status: 200, body: { data: [{ values: [{ code: 'UA', description: 'Україна' }] }] } };
    routes['/ehealth/addresses/regions'] = { status: 200, body: { data: [{ name: 'ЧЕРКАСЬКА' }, { region: 'ВІННИЦЬКА' }, { name: 'ІВАНО-ФРАНКІВСЬКА' }] } };
    const d = await loadFormDictionaries();
    expect(d.identityDocs).toEqual([{ value: 'PASSPORT', label: 'Паспорт' }]);
    expect(d.capacityDocs).toEqual([{ value: 'LEGAL_CAPACITY_CERTIFICATE', label: 'Свідоцтво' }]);
    expect(d.gender).toEqual([{ value: 'MALE', label: 'Чоловіча' }, { value: 'FEMALE', label: 'Жіноча' }]);
    expect(d.regions).toEqual(['ВІННИЦЬКА', 'ІВАНО-ФРАНКІВСЬКА', 'ЧЕРКАСЬКА']);
    expect(d.countries).toEqual(['Україна']);
    expect(d.settlementTypes).toEqual({ CITY: 'місто' });
    expect(d.streetTypes).toEqual([]);
    expect(d.failed).toBe(false);
  });

  test('loadFormDictionaries: без типів документів або областей — failed', async () => {
    const d = await loadFormDictionaries();
    expect(d.failed).toBe(true);
    expect(d.gender).toHaveLength(2);
  });

  test('searchSettlements: параметри запиту і підпис варіанта', async () => {
    routes[`/ehealth/addresses/settlements?region=${encodeURIComponent('ЧЕРКАСЬКА')}&name=${encodeURIComponent('Мор')}`] = {
      status: 200, body: { data: [{ id: 'S-1', name: 'Моринці', district: 'Звенигородський', type: 'VILLAGE' }, { id: 'x' }] },
    };
    const list = await searchSettlements('ЧЕРКАСЬКА', 'Мор');
    expect(list).toEqual([{ id: 'S-1', name: 'Моринці', type: 'VILLAGE', district: 'Звенигородський' }]);
    expect(settlementLabel(list[0])).toBe('Моринці, Звенигородський р-н (VILLAGE)');
    expect(settlementLabel(list[0], { VILLAGE: 'село' })).toBe('Моринці, Звенигородський р-н (село)');
    expect(settlementLabel({ id: '1', name: 'Київ', type: '', district: '' })).toBe('Київ');
  });

  test('підказки країни народження', () => {
    const countries = ['Україна', 'Угорщина', 'Велика Британія', 'Бразилія'];
    expect(countrySuggestions(countries, 'у')).toEqual([]);
    expect(countrySuggestions(countries, 'ук')).toEqual(['Україна']);
    expect(countrySuggestions(countries, 'бр')).toEqual(['Бразилія', 'Велика Британія']);
    expect(countrySuggestions(countries, 'україна')).toEqual([]);
  });
});
