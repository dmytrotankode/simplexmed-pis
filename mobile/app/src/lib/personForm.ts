/**
 * Форма персональних даних пацієнта: реєстрація в ЕСОЗ (п.3.5 ТВ ПІС) і запит на зміну даних (п.3.10.1).
 *
 * Логіка повторює веб-кабінет (pis/web/index.html: collectPerson, fillPersonForm, needsCapacityDoc, ...).
 * Дані перевіряє сервер (pis/backend/ehealth_pis/registration.py) — помилки полів (422 {fields}) показуються
 * біля полів. На клієнті перевіряється лише формат дат ДД.ММ.РРРР (у веб це гарантує <input type="date">),
 * щоб правила Системи не дублювалися в застосунку і не розходилися з сервером.
 */
import { ApiError, api } from './api';

export type Rec = Record<string, any>;

/** Документи, що посвідчують особу, допустимі для реєстрації: ТВ ПІС v2 п.3.4.5.9.a (як у веб і registration.py). */
export const REGISTRATION_DOCUMENT_TYPES = [
  'PASSPORT', 'NATIONAL_ID', 'BIRTH_CERTIFICATE', 'TEMPORARY_CERTIFICATE',
  'REFUGEE_CERTIFICATE', 'PERMANENT_RESIDENCE_PERMIT', 'COMPLEMENTARY_PROTECTION_CERTIFICATE', 'TEMPORARY_PASSPORT',
  'BIRTH_CERTIFICATE_FOREIGN',
];
/** Вік, з якого потрібен документ про дієздатність, і вік повної дієздатності. */
export const CAPACITY_AGE_FROM = 14;
export const CAPACITY_AGE_TO = 18;

export type DocFields = { type: string; number: string; issued_at: string; issued_by: string; expiration_date: string };
export type Settlement = { id: string; name: string; type: string; district: string };
export type PersonFormValues = {
  last_name: string;
  first_name: string;
  second_name: string;
  /** ДД.ММ.РРРР */
  birth_date: string;
  gender: string;
  birth_country: string;
  birth_settlement: string;
  unzr: string;
  tax_id: string;
  no_tax_id: boolean;
  secret: string;
  email: string;
  preferred_way_communication: string;
  /** Документ, що посвідчує особу (дати — ДД.ММ.РРРР). */
  doc: DocFields;
  /** Документ про дієздатність (14–17 років). */
  cap: DocFields;
  region: string;
  settlement_query: string;
  settlement: Settlement | null;
  addr: { street_type: string; street: string; building: string; apartment: string; zip: string };
  phone: string;
  /** Лише для реєстрації: телефон методу автентифікації (SMS). */
  auth_phone: string;
  ec: { last_name: string; first_name: string; second_name: string; phone: string };
};
/** Дані запису ЕСОЗ, яких форма не показує: передаються без змін (як st.extra* у веб). */
export type PersonExtras = { documents: Rec[]; addresses: Rec[]; phones: Rec[]; residence: Rec };
/** п.3.10.1.1: РНОКПП і УНЗР, заповнені раніше, змінювати не можна. */
export type PersonLocks = { taxId: boolean; unzr: boolean };
export type FieldError = { field: string; message: string };

const EMPTY_DOC: DocFields = { type: '', number: '', issued_at: '', issued_by: '', expiration_date: '' };

export function emptyPersonForm(): PersonFormValues {
  return {
    last_name: '', first_name: '', second_name: '', birth_date: '', gender: '', birth_country: '', birth_settlement: '',
    unzr: '', tax_id: '', no_tax_id: false, secret: '', email: '',
    // У веб перший варіант списку — «Телефон»
    preferred_way_communication: 'phone',
    doc: { ...EMPTY_DOC }, cap: { ...EMPTY_DOC },
    region: '', settlement_query: '', settlement: null,
    addr: { street_type: '', street: '', building: '', apartment: '', zip: '' },
    phone: '', auth_phone: '',
    ec: { last_name: '', first_name: '', second_name: '', phone: '' },
  };
}

export function emptyExtras(): PersonExtras {
  return { documents: [], addresses: [], phones: [], residence: {} };
}

// ----------------------------------------------------------------------------
// Дати: у формі ДД.ММ.РРРР, у запитах — РРРР-ММ-ДД
// ----------------------------------------------------------------------------

/** Маска введення дати: лише цифри, крапки ставляться автоматично. */
export function maskDate(input: string): string {
  const d = input.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}.${d.slice(2)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`;
}

/** 'ДД.ММ.РРРР' -> 'РРРР-ММ-ДД' або null, якщо дата некоректна. */
export function parseDisplayDate(text: string): string | null {
  const m = String(text ?? '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** 'РРРР-ММ-ДД[...]' з ЕСОЗ -> 'ДД.ММ.РРРР'. */
export function isoToDisplay(value?: string | null): string {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value ?? '');
}

/** Значення дати для запиту: коректна дата — ISO; порожньо — ''; інше передається як є (сервер відхилить). */
export function toIsoDate(text: string): string {
  const t = String(text ?? '').trim();
  return t ? parseDisplayDate(t) ?? t : '';
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Повних років на дату today (як age_on у registration.py); null — дата народження не вказана/некоректна. */
export function ageFromIso(birthIso: string | null, today: Date = new Date()): number | null {
  const m = String(birthIso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [by, bm, bd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [ty, tm, td] = localIso(today).split('-').map(Number);
  return ty - by - ((tm < bm || (tm === bm && td < bd)) ? 1 : 0);
}

/** formAge у веб. */
export function formAge(values: Pick<PersonFormValues, 'birth_date'>, today: Date = new Date()): number | null {
  return ageFromIso(parseDisplayDate(values.birth_date), today);
}

/** needsCapacityDoc у веб: 14–17 років — потрібен документ, що посвідчує дієздатність. */
export function needsCapacityDoc(values: Pick<PersonFormValues, 'birth_date'>, today: Date = new Date()): boolean {
  const age = formAge(values, today);
  return age !== null && age >= CAPACITY_AGE_FROM && age < CAPACITY_AGE_TO;
}

// ----------------------------------------------------------------------------
// Телефони
// ----------------------------------------------------------------------------

/**
 * Український номер у форматі +380XXXXXXXXX (як normalize_phone у pis_service.py), якщо введено
 * лише цифри, пробіли, дужки, дефіси і «+». Інше лишається як є — формат перевірить сервер.
 */
export function normalizePhone(value: string): string {
  const v = String(value ?? '').trim();
  if (!v || !/^[\d\s()+-]+$/.test(v)) return v;
  const digits = v.replace(/\D/g, '');
  if (digits.startsWith('380') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('80') && digits.length === 11) return `+3${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+38${digits}`;
  return v.replace(/[\s()-]/g, '');
}

// ----------------------------------------------------------------------------
// Збирання даних персони (collectPerson) і заповнення форми (fillPersonForm)
// ----------------------------------------------------------------------------

function docPayload(d: DocFields): Rec {
  return {
    type: d.type.trim(), number: d.number.trim(), issued_at: toIsoDate(d.issued_at),
    issued_by: d.issued_by.trim(), expiration_date: toIsoDate(d.expiration_date),
  };
}

/** collectPerson у веб. Документи/адреси/телефони, яких форма не показує, зберігаються без змін. */
export function buildPerson(values: PersonFormValues, extras: PersonExtras,
                            { withAuthMethod, today = new Date() }: { withAuthMethod: boolean; today?: Date }): Rec {
  const s = values.settlement;
  const documents = [docPayload(values.doc)];
  if (needsCapacityDoc(values, today)) documents.push(docPayload(values.cap));
  const residence: Rec = {
    ...extras.residence,
    type: 'RESIDENCE', country: 'UA', area: values.region.trim(),
    region: s?.district ?? '', settlement: s?.name ?? '', settlement_type: s?.type ?? '', settlement_id: s?.id ?? '',
    street_type: values.addr.street_type.trim(), street: values.addr.street.trim(), building: values.addr.building.trim(),
    apartment: values.addr.apartment.trim(), zip: values.addr.zip.trim(),
  };
  const phone = normalizePhone(values.phone);
  const person: Rec = {
    first_name: values.first_name.trim(), last_name: values.last_name.trim(), second_name: values.second_name.trim(),
    birth_date: toIsoDate(values.birth_date), birth_country: values.birth_country.trim(),
    birth_settlement: values.birth_settlement.trim(), gender: values.gender, email: values.email.trim(),
    no_tax_id: values.no_tax_id,
    // toggleNoTaxId: при відмові від РНОКПП поле очищається
    tax_id: values.no_tax_id ? '' : values.tax_id.trim(),
    secret: values.secret.trim(), unzr: values.unzr.trim(),
    documents: documents.concat(extras.documents),
    addresses: [residence].concat(extras.addresses),
    phones: (phone ? [{ type: 'MOBILE', number: phone } as Rec] : []).concat(extras.phones),
    preferred_way_communication: values.preferred_way_communication,
    emergency_contact: {
      first_name: values.ec.first_name.trim(), last_name: values.ec.last_name.trim(), second_name: values.ec.second_name.trim(),
      phones: [{ type: 'MOBILE', number: normalizePhone(values.ec.phone) }],
    },
  };
  if (withAuthMethod) {
    person.authentication_methods = [{ type: 'OTP', phone_number: normalizePhone(values.auth_phone) || phone }];
  }
  return person;
}

/** п.3.5.8.2.1: повідомлення після реєстрації, якщо потрібні копії документів. */
export const DOCUMENTS_UPLOAD_MESSAGE =
  'Завантажте копії ваших документів. До завантаження документів можливості особистого кабінету пацієнта будуть обмежені.';

/**
 * п.3.5.8.2: копії документів потрібні, якщо серед документів є посвідка на постійне проживання
 * або (для віку від no_self_registration_age до повної дієздатності) документ про дієздатність.
 */
export function signUpNeedsDocuments(person: Rec, capacityShown: boolean): boolean {
  const docs: Rec[] = Array.isArray(person?.documents) ? person.documents : [];
  return docs.some((d) => d?.type === 'PERMANENT_RESIDENCE_PERMIT') ||
    (capacityShown && docs.some((d) => d?.type && !REGISTRATION_DOCUMENT_TYPES.includes(d.type)));
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function docFields(d: Rec | null | undefined): DocFields {
  return {
    type: str(d?.type), number: str(d?.number), issued_at: isoToDisplay(d?.issued_at),
    issued_by: str(d?.issued_by), expiration_date: isoToDisplay(d?.expiration_date),
  };
}

/** fillPersonForm у веб: значення форми з "PIS. Get Person details", незмінні частини запису і блокування полів. */
export function fillFromPerson(p: Rec, today: Date = new Date()): { values: PersonFormValues; extras: PersonExtras; locks: PersonLocks } {
  const values = emptyPersonForm();
  values.first_name = str(p.first_name);
  values.last_name = str(p.last_name);
  values.second_name = str(p.second_name);
  values.birth_date = isoToDisplay(p.birth_date);
  values.birth_country = str(p.birth_country);
  values.birth_settlement = str(p.birth_settlement);
  values.gender = str(p.gender);
  values.email = str(p.email);
  values.secret = str(p.secret);
  values.preferred_way_communication = str(p.preferred_way_communication);
  values.no_tax_id = Boolean(p.no_tax_id);
  values.tax_id = str(p.tax_id);
  values.unzr = str(p.unzr);

  const docs: Rec[] = Array.isArray(p.documents) ? p.documents : [];
  const identity = docs.find((d) => REGISTRATION_DOCUMENT_TYPES.includes(d?.type)) ?? null;
  values.doc = docFields(identity);
  const capacity = needsCapacityDoc(values, today) ? docs.find((d) => d !== identity) ?? null : null;
  values.cap = docFields(capacity);

  const addresses: Rec[] = Array.isArray(p.addresses) ? p.addresses : [];
  const res = addresses.find((a) => a?.type === 'RESIDENCE') ?? null;
  values.addr = {
    street_type: str(res?.street_type), street: str(res?.street), building: str(res?.building),
    apartment: str(res?.apartment), zip: str(res?.zip),
  };
  values.region = str(res?.area);
  values.settlement = res?.settlement_id
    ? { id: str(res.settlement_id), name: str(res.settlement), type: str(res.settlement_type), district: str(res.region) }
    : null;
  values.settlement_query = str(res?.settlement);

  const phones: Rec[] = Array.isArray(p.phones) ? p.phones : [];
  const mobile = phones.find((ph) => ph?.type === 'MOBILE') ?? null;
  values.phone = str(mobile?.number);
  const ec: Rec = p.emergency_contact ?? {};
  values.ec = {
    first_name: str(ec.first_name), last_name: str(ec.last_name), second_name: str(ec.second_name),
    phone: str((Array.isArray(ec.phones) ? ec.phones[0] : null)?.number),
  };

  return {
    values,
    extras: {
      documents: docs.filter((d) => d !== identity && d !== capacity),
      addresses: addresses.filter((a) => a !== res),
      phones: phones.filter((ph) => ph !== mobile),
      residence: res ?? {},
    },
    locks: { taxId: Boolean(p.tax_id), unzr: Boolean(p.unzr) },
  };
}

// ----------------------------------------------------------------------------
// Помилки: формат дат на клієнті і помилки полів від сервера
// ----------------------------------------------------------------------------

const DATE_FORMAT_HINT = 'вкажіть дату у форматі ДД.ММ.РРРР';

/** Перевірка формату заповнених дат (порожні обов'язкові дати перевіряє сервер). */
export function validateDates(values: PersonFormValues, capacityShown: boolean): FieldError[] {
  const checks: [string, string, string][] = [
    ['birth_date', 'Дата народження', values.birth_date],
    ['doc.issued_at', 'Документ: дата видачі', values.doc.issued_at],
    ['doc.expiration_date', 'Документ: дійсний до', values.doc.expiration_date],
  ];
  if (capacityShown) {
    checks.push(['cap.issued_at', 'Документ про дієздатність: дата видачі', values.cap.issued_at]);
    checks.push(['cap.expiration_date', 'Документ про дієздатність: дійсний до', values.cap.expiration_date]);
  }
  return checks
    .filter(([, , v]) => v.trim() !== '' && parseDisplayDate(v) === null)
    .map(([field, label]) => ({ field, message: `${label}: ${DATE_FORMAT_HINT}` }));
}

/** Помилки полів з відповіді 422 {fields: [{field, message}]} або null, якщо їх немає. */
export function serverFieldErrors(e: unknown): FieldError[] | null {
  if (!(e instanceof ApiError) || !Array.isArray(e.body.fields)) return null;
  const list = (e.body.fields as unknown[])
    .filter((f): f is Rec => typeof f === 'object' && f !== null)
    .map((f) => ({ field: str(f.field), message: str(f.message) }))
    .filter((f) => f.message);
  return list.length ? list : null;
}

const DIRECT_FIELDS = new Set([
  'first_name', 'last_name', 'second_name', 'birth_date', 'gender', 'birth_country', 'birth_settlement',
  'email', 'tax_id', 'secret', 'unzr', 'preferred_way_communication',
]);

/**
 * Поле форми для помилки сервера. Порядок у запиті як у buildPerson: documents[0] — документ особи,
 * documents[1] — документ про дієздатність (якщо показаний), addresses[0] — адреса проживання,
 * phones[0] — мобільний телефон (якщо вказаний). Решта — дані запису, яких форма не показує.
 */
export function formFieldFor(field: string, ctx: { capacityShown: boolean; hasPhone: boolean }): string | null {
  if (DIRECT_FIELDS.has(field)) return field;
  if (field === 'documents') return 'documents';
  if (field === 'addresses') return 'addresses';
  if (field === 'authentication_methods') return 'auth_phone';
  if (field === 'emergency_contact') return 'ec';
  if (field === 'emergency_contact.phones') return 'ec.phone';
  let m = field.match(/^documents\[(\d+)\]\.(\w+)$/);
  if (m) {
    const i = Number(m[1]);
    if (i === 0) return `doc.${m[2]}`;
    if (i === 1 && ctx.capacityShown) return `cap.${m[2]}`;
    return null;
  }
  m = field.match(/^addresses\[(\d+)\]\.(\w+)$/);
  if (m) {
    if (Number(m[1]) !== 0) return null;
    return m[2] === 'country' || m[2] === 'area' ? 'region' : m[2].startsWith('settlement') ? 'settlement' : null;
  }
  m = field.match(/^phones\[(\d+)\]$/);
  if (m) return Number(m[1]) === 0 && ctx.hasPhone ? 'phone' : null;
  return null;
}

/** Помилки біля полів (кілька повідомлень одного поля — з нового рядка) і перелік усіх повідомлень, як у веб. */
export function mapFieldErrors(fields: FieldError[], ctx: { capacityShown: boolean; hasPhone: boolean }):
  { byField: Record<string, string>; messages: string[] } {
  const grouped: Record<string, string[]> = {};
  const messages: string[] = [];
  for (const f of fields) {
    if (!messages.includes(f.message)) messages.push(f.message);
    const key = formFieldFor(f.field, ctx);
    if (!key) continue;
    grouped[key] = grouped[key] ?? [];
    if (!grouped[key].includes(f.message)) grouped[key].push(f.message);
  }
  const byField: Record<string, string> = {};
  for (const [k, v] of Object.entries(grouped)) byField[k] = v.join('\n');
  return { byField, messages };
}

/** Текст для ErrorBox: перелік повідомлень, як showErrors у веб. */
export function errorSummary(messages: string[]): string | null {
  if (!messages.length) return null;
  return messages.length === 1 ? messages[0] : messages.map((m) => `• ${m}`).join('\n');
}

// ----------------------------------------------------------------------------
// Попередження п.3.10.1.5
// ----------------------------------------------------------------------------

export const PENDING_DECLARATION_REQUESTS_WARNING =
  'Після збереження змінених персональних даних, наявні Запити на реєстрацію запису про Декларацію будуть анульовані. ' +
  'Подана Декларація залишиться чинною.\n\nПродовжити?';

export function hasPendingDeclarationRequests(list: Rec[]): boolean {
  return list.some((d) => ['NEW', 'APPROVED'].includes(str(d?.status).toUpperCase()));
}

// ----------------------------------------------------------------------------
// Довідники і адреси ЕСОЗ. На сервері вони публічні (без сесії): реєстрація відбувається до входу.
// ----------------------------------------------------------------------------

export type DictValue = { code: string; description?: string; is_active?: boolean };
export type Option = { value: string; label: string };

export const GENDER_FALLBACK: DictValue[] = [{ code: 'MALE', description: 'Чоловіча' }, { code: 'FEMALE', description: 'Жіноча' }];

const dictCache: Record<string, DictValue[]> = {};

/** Очищення кешу довідників (для тестів). */
export function clearDictionaryCache(): void {
  for (const k of Object.keys(dictCache)) delete dictCache[k];
}

/** loadDictionary у веб: активні значення довідника. Порожній результат не кешується — можна повторити. */
export async function loadDictionary(name: string, token?: string | null): Promise<DictValue[]> {
  if (dictCache[name]) return dictCache[name];
  const r = await api<{ data?: Rec[] }>(`/ehealth/dictionaries?name=${encodeURIComponent(name)}`, { token });
  const dict = (r.data ?? [])[0];
  const values = ((dict?.values ?? []) as DictValue[]).filter((v) => v && v.is_active !== false);
  if (values.length) dictCache[name] = values;
  return values;
}

export function toOptions(values: DictValue[]): Option[] {
  return values.map((v) => ({ value: v.code, label: v.description || v.code }));
}

/** Назви областей, відсортовані за українським алфавітом. */
export async function loadRegions(token?: string | null): Promise<string[]> {
  const r = await api<{ data?: Rec[] }>('/ehealth/addresses/regions', { token });
  return (r.data ?? [])
    .map((x) => str(x?.region || x?.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'uk'));
}

/** searchSettlements у веб: пошук населеного пункту в області за назвою. */
export async function searchSettlements(region: string, name: string, token?: string | null): Promise<Settlement[]> {
  const r = await api<{ data?: Rec[] }>(
    `/ehealth/addresses/settlements?region=${encodeURIComponent(region)}&name=${encodeURIComponent(name)}`, { token });
  return (r.data ?? []).filter((s) => s && s.name).map((s) => ({
    id: str(s.id), name: str(s.name), type: str(s.type), district: str(s.district),
  }));
}

export function settlementLabel(s: Settlement, typeLabels: Record<string, string> = {}): string {
  const type = s.type ? typeLabels[s.type] || s.type : '';
  return `${s.name}${s.district ? `, ${s.district} р-н` : ''}${type ? ` (${type})` : ''}`;
}

/** Підказки країни народження (datalist у веб). */
export function countrySuggestions(countries: string[], query: string, limit = 6): string[] {
  const q = query.trim().toLocaleLowerCase('uk');
  if (q.length < 2 || countries.some((c) => c.toLocaleLowerCase('uk') === q)) return [];
  const starts = countries.filter((c) => c.toLocaleLowerCase('uk').startsWith(q));
  const contains = countries.filter((c) => !starts.includes(c) && c.toLocaleLowerCase('uk').includes(q));
  return starts.concat(contains).slice(0, limit);
}

export type FormDictionaries = {
  gender: Option[];
  identityDocs: Option[];
  capacityDocs: Option[];
  streetTypes: Option[];
  countries: string[];
  regions: string[];
  settlementTypes: Record<string, string>;
  /** Не вдалося завантажити довідник, без якого форму не заповнити. */
  failed: boolean;
};

/** prepareForm у веб: довідники форми. Помилка одного довідника не зупиняє інші. */
export async function loadFormDictionaries(token?: string | null): Promise<FormDictionaries> {
  let failed = false;
  const safe = async <T>(fn: () => Promise<T>, empty: T, required: boolean): Promise<T> => {
    try {
      const v = await fn();
      if (required && Array.isArray(v) && v.length === 0) failed = true;
      return v;
    } catch {
      if (required) failed = true;
      return empty;
    }
  };
  const [gender, docTypes, streetTypes, countries, settlementTypes, regions] = await Promise.all([
    safe(() => loadDictionary('GENDER', token), [] as DictValue[], false),
    safe(() => loadDictionary('DOCUMENT_TYPE', token), [] as DictValue[], true),
    safe(() => loadDictionary('STREET_TYPE', token), [] as DictValue[], false),
    safe(() => loadDictionary('COUNTRY', token), [] as DictValue[], false),
    safe(() => loadDictionary('SETTLEMENT_TYPE', token), [] as DictValue[], false),
    safe(() => loadRegions(token), [] as string[], true),
  ]);
  return {
    gender: toOptions(gender.length ? gender : GENDER_FALLBACK),
    identityDocs: toOptions(docTypes.filter((v) => REGISTRATION_DOCUMENT_TYPES.includes(v.code))),
    capacityDocs: toOptions(docTypes.filter((v) => !REGISTRATION_DOCUMENT_TYPES.includes(v.code))),
    streetTypes: toOptions(streetTypes),
    countries: countries.map((v) => v.description || v.code),
    regions,
    settlementTypes: Object.fromEntries(settlementTypes.map((v) => [v.code, v.description || v.code])),
    failed,
  };
}
