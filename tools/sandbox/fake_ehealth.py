"""
Імітація ЦБД ЕСОЗ (PIS API) для локального стенду кабінету — лише для розробки й тестування.

Відповіді побудовано за структурами даних pis/docs/ehealth-pis-api.apib (pis_person_response,
Declaration_Details_PIS, Declaration_request_details, Person_request_details, Approval_Response,
*_bulk, Dictionary_v2, Response_Collection_V2 тощо). Стан змінюється так само, як у Системі:
підписаний запит на декларацію створює декларацію, припинення змінює статус, запит на зміну даних
після підпису оновлює запис про пацієнта.

Підпис КЕП на стенді імітується (tools/sandbox/fake_kep.js): signed_content = base64("SANDBOX-SIGNED\\n" + дані).
Імітація перевіряє, що підписано саме те, що вимагає Система (nonce, data_to_be_signed, запит на зміну).

Транспорт підміняє UrllibTransport: request(method, url, headers, body, timeout) -> HttpResponse.
"""

import base64
import copy
import json
import re
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

SIGN_PREFIX = "SANDBOX-SIGNED\n"
NOW = lambda: datetime.now(timezone.utc)  # noqa: E731


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def uid():
    return str(uuid.uuid4())


def sandbox_sign(text):
    return base64.b64encode((SIGN_PREFIX + text).encode("utf-8")).decode("ascii")


def unsign(signed):
    """Повертає підписаний текст або None, якщо це не підпис стенду."""
    try:
        raw = base64.b64decode(signed, validate=True).decode("utf-8")
    except Exception:
        return None
    return raw[len(SIGN_PREFIX):] if raw.startswith(SIGN_PREFIX) else None


# ----------------------------------------------------------------------------
# Довідники (Dictionary_v2). Описи — як у довідниках ЕСОЗ.
# ----------------------------------------------------------------------------

DICTIONARIES = {
    "GENDER": {"MALE": "чоловіча", "FEMALE": "жіноча"},
    "COUNTRY": {"UA": "Україна", "PL": "Польща", "DE": "Німеччина", "MD": "Молдова"},
    "DOCUMENT_TYPE": {
        "PASSPORT": "Паспорт громадянина України", "NATIONAL_ID": "Біометричний паспорт громадянина України",
        "BIRTH_CERTIFICATE": "Свідоцтво про народження", "BIRTH_CERTIFICATE_FOREIGN": "Свідоцтво про народження, видане за кордоном",
        "COMPLEMENTARY_PROTECTION_CERTIFICATE": "Посвідчення особи, яка потребує додаткового захисту",
        "REFUGEE_CERTIFICATE": "Посвідка біженця", "TEMPORARY_CERTIFICATE": "Посвідка на тимчасове проживання",
        "PERMANENT_RESIDENCE_PERMIT": "Посвідка на постійне проживання", "TEMPORARY_PASSPORT": "Тимчасове посвідчення громадянина України",
        "TAX_ID": "РНОКПП",
    },
    "ADDRESS_TYPE": {"RESIDENCE": "Адреса проживання", "REGISTRATION": "Адреса реєстрації"},
    "SETTLEMENT_TYPE": {"CITY": "місто", "TOWNSHIP": "селище міського типу", "VILLAGE": "село", "SETTLEMENT": "селище"},
    "STREET_TYPE": {"STREET": "вулиця", "AVENUE": "проспект", "BOULEVARD": "бульвар", "LANE": "провулок", "SQUARE": "площа"},
    "PHONE_TYPE": {"MOBILE": "мобільний", "LAND_LINE": "стаціонарний"},
    "AUTHENTICATION_METHOD": {"OTP": "Двофакторна автентифікація (SMS)", "OFFLINE": "Без двофакторної автентифікації",
                              "THIRD_PERSON": "Через третю особу", "NA": "Не визначено"},
    "PREFERRED_WAY_COMMUNICATION": {"email": "Електронна пошта", "phone": "Телефон"},
    "SPECIALITY_TYPE": {"FAMILY_DOCTOR": "Лікар загальної практики – сімейний лікар", "THERAPIST": "Терапевт",
                        "PEDIATRICIAN": "Педіатр", "CARDIOLOGY": "Кардіологія"},
    "SPECIALITY_LEVEL": {"BASIC": "Без категорії", "SECOND": "Друга категорія", "FIRST": "Перша категорія", "HIGHEST": "Вища категорія"},
    "SPEC_QUALIFICATION_TYPE": {"AWARDING": "Присвоєння", "CONFIRMATION": "Підтвердження"},
    "EDUCATION_DEGREE": {"MASTER": "Магістр", "SPECIALIST": "Спеціаліст", "BACHELOR": "Бакалавр"},
    "QUALIFICATION_TYPE": {"SPECIALIZATION": "Спеціалізація", "TOPIC_IMPROVEMENT": "Тематичне удосконалення",
                           "INTERNSHIP": "Інтернатура"},
    "SCIENCE_DEGREE": {"CANDIDATE_OF_SCIENCE": "Кандидат наук", "DOCTOR_OF_SCIENCE": "Доктор наук"},
    "DIVISION_TYPE": {"CLINIC": "Клініка", "AMBULANT_CLINIC": "Амбулаторія", "FAP": "ФАП"},
    "POSITION": {"P1": "Головний лікар", "P2": "Лікар загальної практики – сімейний лікар", "P6": "Лікар-терапевт",
                 "P7": "Лікар-педіатр"},
    "DECLARATION_STATUS_REASON": {"manual_person": "Припинено пацієнтом", "manual_employee": "Припинено лікарем",
                                  "auto_new_declaration": "Подано нову декларацію",
                                  "auto_employee_dismissed": "Лікаря звільнено"},
    "DECLARATION_REQUEST_STATUS_REASON": {"auto_expired": "Сплив строк дії запиту",
                                          "manual_person": "Відхилено пацієнтом", "manual_employee": "Відхилено лікарем"},
    "PERSON_VERIFICATION_STATUSES": {"VERIFIED": "Верифіковано", "NOT_VERIFIED": "Не верифіковано",
                                     "VERIFICATION_NEEDED": "Потребує верифікації", "IN_REVIEW": "На перевірці",
                                     "VERIFICATION_NOT_NEEDED": "Верифікація не потрібна", "CHANGES_NEEDED": "Потребує змін"},
    "PERSON_VERIFICATION_STATUS_REASONS": {"AUTO": "Встановлено автоматично", "AUTO_ONLINE": "Встановлено автоматично онлайн",
                                          "MANUAL_CONFIRMED": "Підтверджено вручну", "MANUAL_NOT_VERIFIED": "Не підтверджено вручну",
                                          "AUTO_DATA_ABSENT": "Дані відсутні", "AUTO_OFFLINE": "Встановлено автоматично офлайн"},
    "SCOPES": {
        "app:read_pis": "Перегляд доступів, наданих застосункам", "app:delete_pis": "Відкликання доступів, наданих застосункам",
        "person:details_pis": "Перегляд запису про пацієнта", "person_verification:details_pis": "Перегляд статусів верифікації",
        "person_documents:write_pis": "Завантаження копій документів",
        "authentication_method:read_pis": "Перегляд методів автентифікації",
        "authentication_method:write_pis": "Зміна методів автентифікації",
        "authentication_method:deactivate_pis": "Деактивація методів автентифікації",
        "authentication_method_request:write_pis": "Запити на додавання методів автентифікації",
        "person_request:read_pis": "Перегляд запитів на зміну даних", "person_request:details_pis": "Деталі запитів на зміну даних",
        "person_request:write_pis": "Створення запитів на зміну даних", "person_request:reject_pis": "Відхилення запитів на зміну даних",
        "declaration:read_pis": "Перегляд декларацій", "declaration:details_pis": "Деталі декларацій",
        "declaration:terminate_pis": "Припинення декларацій", "declaration_request:read_pis": "Перегляд запитів на декларацію",
        "declaration_request:details_pis": "Деталі запитів на декларацію", "declaration_request:write_pis": "Створення запитів на декларацію",
        "declaration_request:sign_pis": "Підписання запитів на декларацію",
        "declaration_request:reject_pis": "Відхилення запитів на декларацію",
        "patients:read": "Перегляд медичних записів пацієнта", "notebooks:read": "Перегляд щоденника",
    },
}


def dictionary_v2(name):
    values = DICTIONARIES.get(name)
    if values is None:
        return []
    return [{"name": name, "description": name, "is_active": True, "labels": ["SYSTEM"],
             "values": [{"code": c, "description": d, "is_active": True, "child_values": []} for c, d in values.items()]}]


# ----------------------------------------------------------------------------
# Адреси (UAaddresses)
# ----------------------------------------------------------------------------

REGIONS = [
    {"id": "r-kyiv-city", "region": "М.КИЇВ", "koatuu": "8000000000"},
    {"id": "r-kyivska", "region": "КИЇВСЬКА", "koatuu": "3200000000"},
    {"id": "r-lvivska", "region": "ЛЬВІВСЬКА", "koatuu": "4600000000"},
    {"id": "r-vinnytska", "region": "ВІННИЦЬКА", "koatuu": "0500000000"},
]
DISTRICTS = [
    {"id": "d-kyiv", "region": "М.КИЇВ", "region_id": "r-kyiv-city", "district": "КИЇВ", "koatuu": "8000000000"},
    {"id": "d-boryspil", "region": "КИЇВСЬКА", "region_id": "r-kyivska", "district": "БОРИСПІЛЬСЬКИЙ", "koatuu": "3220800000"},
    {"id": "d-buchanskyi", "region": "КИЇВСЬКА", "region_id": "r-kyivska", "district": "БУЧАНСЬКИЙ", "koatuu": "3222400000"},
    {"id": "d-lviv", "region": "ЛЬВІВСЬКА", "region_id": "r-lvivska", "district": "ЛЬВІВСЬКИЙ", "koatuu": "4610100000"},
    {"id": "d-vinnytsia", "region": "ВІННИЦЬКА", "region_id": "r-vinnytska", "district": "ВІННИЦЬКИЙ", "koatuu": "0510100000"},
]
SETTLEMENTS = [
    {"id": "s-kyiv", "name": "КИЇВ", "type": "CITY", "district_id": "d-kyiv", "region_id": "r-kyiv-city", "koatuu": "8000000000"},
    {"id": "s-boryspil", "name": "БОРИСПІЛЬ", "type": "CITY", "district_id": "d-boryspil", "region_id": "r-kyivska", "koatuu": "3210500000"},
    {"id": "s-hora", "name": "ГОРА", "type": "VILLAGE", "district_id": "d-boryspil", "region_id": "r-kyivska", "koatuu": "3220882601"},
    {"id": "s-bucha", "name": "БУЧА", "type": "CITY", "district_id": "d-buchanskyi", "region_id": "r-kyivska", "koatuu": "3210800000"},
    {"id": "s-irpin", "name": "ІРПІНЬ", "type": "CITY", "district_id": "d-buchanskyi", "region_id": "r-kyivska", "koatuu": "3210900000"},
    {"id": "s-lviv", "name": "ЛЬВІВ", "type": "CITY", "district_id": "d-lviv", "region_id": "r-lvivska", "koatuu": "4610100000"},
    {"id": "s-vinnytsia", "name": "ВІННИЦЯ", "type": "CITY", "district_id": "d-vinnytsia", "region_id": "r-vinnytska", "koatuu": "0510100000"},
]
STREETS = [
    {"id": "st-1", "settlement_id": "s-kyiv", "type": "STREET", "name": "Хрещатик"},
    {"id": "st-2", "settlement_id": "s-kyiv", "type": "AVENUE", "name": "Берестейський"},
    {"id": "st-3", "settlement_id": "s-kyiv", "type": "STREET", "name": "Ніжинська"},
    {"id": "st-4", "settlement_id": "s-boryspil", "type": "STREET", "name": "Київський Шлях"},
    {"id": "st-5", "settlement_id": "s-lviv", "type": "STREET", "name": "Городоцька"},
]


def settlement_view(s):
    region = next(r for r in REGIONS if r["id"] == s["region_id"])
    district = next(d for d in DISTRICTS if d["id"] == s["district_id"])
    return {"id": s["id"], "name": s["name"], "type": s["type"], "region": region["region"], "region_id": region["id"],
            "district": district["district"], "district_id": district["id"], "mountain_group": "0", "koatuu": s["koatuu"]}


def address(kind, settlement_id, street="Ніжинська", building="15", apartment="23", zip_code="02090",
            street_type="STREET"):
    s = settlement_view(next(x for x in SETTLEMENTS if x["id"] == settlement_id))
    return {"type": kind, "country": "UA", "area": s["region"], "region": s["district"], "settlement": s["name"],
            "settlement_type": s["type"], "settlement_id": s["id"], "street_type": street_type, "street": street,
            "building": building, "apartment": apartment, "zip": zip_code}


# ----------------------------------------------------------------------------
# Реєстри (bulk): МНП, лікарі, договори, ліміти
# ----------------------------------------------------------------------------

def _speciality(code, officio=True, level="FIRST"):
    return {"speciality": code, "speciality_officio": officio, "level": level, "qualification_type": "AWARDING",
            "attestation_name": "Національний медичний університет імені О. О. Богомольця",
            "attestation_date": "2021-06-15", "valid_to_date": "2031-06-15", "certificate_number": "АБ/" + code[:3] + "/21"}


EDUCATION = [{"country": "UA", "city": "Київ", "institution_name": "Національний медичний університет імені О. О. Богомольця",
              "issued_date": "2008-06-30", "diploma_number": "КВ 34567890", "degree": "MASTER", "speciality": "Лікувальна справа"}]
QUALIFICATIONS = [{"type": "SPECIALIZATION", "institution_name": "НУОЗ України імені П. Л. Шупика",
                   "speciality": "Загальна практика – сімейна медицина", "issued_date": "2012-02-28",
                   "certificate_number": "СП-1288", "valid_to": "2027-02-28"}]

LEGAL_ENTITIES = [
    {"id": "le-cpmsd1", "name": "КНП «Центр первинної медико-санітарної допомоги № 1» Печерського району м. Києва",
     "short_name": "ЦПМСД № 1", "public_name": "ЦПМСД № 1 Печерського району", "edrpou": "38523615", "type": "PRIMARY_CARE",
     "settlement": "s-kyiv", "street": "Хрещатик", "building": "40"},
    {"id": "le-zdorovia", "name": "ТОВ «Клініка Здоров'я Родини»", "short_name": "Здоров'я Родини",
     "public_name": "Клініка «Здоров'я Родини»", "edrpou": "41234567", "type": "OUTPATIENT",
     "settlement": "s-boryspil", "street": "Київський Шлях", "building": "2"},
    {"id": "le-lviv", "name": "КНП «2-а міська поліклініка м. Львова»", "short_name": "2-а поліклініка",
     "public_name": "2-а міська поліклініка Львова", "edrpou": "01989023", "type": "PRIMARY_CARE",
     "settlement": "s-lviv", "street": "Городоцька", "building": "120"},
]
DIVISIONS = [
    {"id": "div-pechersk-1", "le": "le-cpmsd1", "name": "Амбулаторія ЗПСМ № 1", "type": "AMBULANT_CLINIC",
     "settlement": "s-kyiv", "street": "Хрещатик", "building": "40", "contract": True},
    {"id": "div-pechersk-2", "le": "le-cpmsd1", "name": "Амбулаторія ЗПСМ № 2", "type": "AMBULANT_CLINIC",
     "settlement": "s-kyiv", "street": "Ніжинська", "building": "7", "contract": True},
    {"id": "div-boryspil", "le": "le-zdorovia", "name": "Відділення «Бориспіль-центр»", "type": "CLINIC",
     "settlement": "s-boryspil", "street": "Київський Шлях", "building": "2", "contract": False},
    {"id": "div-lviv", "le": "le-lviv", "name": "Амбулаторія ЗПСМ «Городоцька»", "type": "AMBULANT_CLINIC",
     "settlement": "s-lviv", "street": "Городоцька", "building": "120", "contract": True},
]
DOCTORS = [
    # (employee_id, party_id, ПІБ, стать, рік, спеціальність, підрозділ, ліміт, кількість декларацій)
    ("emp-koval", "party-koval", ("Коваль", "Ірина", "Василівна"), "FEMALE", 1979, "FAMILY_DOCTOR", "div-pechersk-1", 1800, 1622),
    ("emp-melnyk", "party-melnyk", ("Мельник", "Андрій", "Олегович"), "MALE", 1985, "THERAPIST", "div-pechersk-2", 2000, 1990),
    ("emp-shevchenko", "party-shevchenko", ("Шевченко", "Оксана", "Петрівна"), "FEMALE", 1990, "PEDIATRICIAN", "div-pechersk-1", 900, 412),
    ("emp-bondar", "party-bondar", ("Бондар", "Віктор", "Іванович"), "MALE", 1968, "FAMILY_DOCTOR", "div-boryspil", 1800, 700),
    ("emp-tkachuk", "party-tkachuk", ("Ткачук", "Марія", "Степанівна"), "FEMALE", 1975, "FAMILY_DOCTOR", "div-lviv", 1800, 1800),
    ("emp-oliynyk", "party-oliynyk", ("Олійник", "Сергій", "Миколайович"), "MALE", 1982, "CARDIOLOGY", "div-pechersk-2", None, None),
]


def _division_bulk(d):
    return {"id": d["id"], "external_id": None, "name": d["name"], "type": d["type"], "mountain_group": False,
            "phones": [{"type": "LAND_LINE", "number": "+380442790011"}], "email": "info@" + d["id"] + ".example.ua",
            "inserted_at": "2019-01-10T09:00:00.000Z", "updated_at": "2025-08-01T09:00:00.000Z",
            "legal_entity_id": d["le"], "location": {"latitude": 50.45, "longitude": 30.52}, "status": "ACTIVE",
            "is_active": True, "working_hours": {"mon": [["08.00", "18.00"]], "tue": [["08.00", "18.00"]],
                                                  "wed": [["08.00", "18.00"]], "thu": [["08.00", "18.00"]],
                                                  "fri": [["08.00", "16.00"]]},
            "addresses": [address("RESIDENCE", d["settlement"], d["street"], d["building"], None, "01001")]}


def _legal_entity_bulk(le):
    addr = address("REGISTRATION", le["settlement"], le["street"], le["building"], None, "01001")
    return {"id": le["id"], "name": le["name"], "short_name": le["short_name"], "public_name": le["public_name"],
            "status": "ACTIVE", "type": le["type"], "owner_property_type": "STATE", "legal_form": "430",
            "edrpou": le["edrpou"], "kveds": ["86.10"], "addresses": [addr], "phones": [{"type": "LAND_LINE", "number": "+380442790000"}],
            "email": "office@" + le["id"] + ".example.ua", "is_active": True, "inserted_at": "2018-05-01T09:00:00.000Z",
            "updated_at": "2025-08-01T09:00:00.000Z", "website": None, "residence_address": addr}


def bulk_data(name):
    if name == "legal_entities":
        return [_legal_entity_bulk(le) for le in LEGAL_ENTITIES]
    if name == "divisions":
        return [_division_bulk(d) for d in DIVISIONS]
    if name == "parties":
        return [{"id": p, "last_name": n[0], "first_name": n[1], "second_name": n[2], "year_of_birth": str(y), "gender": g,
                 "inserted_at": "2019-01-10T09:00:00.000Z", "updated_at": "2025-08-01T09:00:00.000Z",
                 "educations": EDUCATION, "qualifications": QUALIFICATIONS, "specialities": [_speciality(s)],
                 "about_myself": "Працюю з дорослими й дітьми, веду хронічних пацієнтів, консультую онлайн.",
                 "working_experience": max(1, date.today().year - y - 25), "verification_status": "VERIFIED"}
                for (_e, p, n, g, y, s, _d, _l, _c) in DOCTORS]
    if name == "employees":
        return [{"id": e, "position": "P2" if s == "FAMILY_DOCTOR" else ("P7" if s == "PEDIATRICIAN" else "P6"),
                 "status": "APPROVED", "employee_type": "DOCTOR", "is_active": True, "start_date": "2019-01-10T09:00:00.000Z",
                 "legal_entity_id": next(dv["le"] for dv in DIVISIONS if dv["id"] == d), "division_id": d, "party_id": p,
                 "inserted_at": "2019-01-10T09:00:00.000Z", "updated_at": "2025-08-01T09:00:00.000Z",
                 "speciality": _speciality(s)} for (e, p, _n, _g, _y, s, d, _l, _c) in DOCTORS]
    if name == "healthcare_services":
        return [{"id": "hs-" + d["id"], "legal_entity_id": d["le"], "division_id": d["id"], "speciality_type": "FAMILY_DOCTOR",
                 "providing_condition": "OUTPATIENT", "category": {"coding": [{"system": "HEALTHCARE_SERVICE_CATEGORIES", "code": "MSP"}]},
                 "status": "ACTIVE", "is_active": True, "inserted_at": "2019-01-10T09:00:00.000Z"} for d in DIVISIONS]
    if name == "employee_roles":
        return [{"id": "role-" + e, "healthcare_service_id": "hs-" + d, "employee_id": e, "start_date": "2019-04-20T19:14:13Z",
                 "status": "ACTIVE", "inserted_at": "2019-04-20T19:14:13Z"} for (e, _p, _n, _g, _y, _s, d, _l, _c) in DOCTORS]
    if name == "contract_divisions":
        return [{"contract_id": "1100027880", "changed_at": "2025-01-25T22:25:16+02:00", "division_id": d["id"],
                 "contract_status": "active", "contract_end_date": f"{date.today().year + 1}-12-31",
                 "contract_start_date": "2025-01-01", "contract_division_status": "active"} for d in DIVISIONS if d["contract"]]
    if name == "declarations_limit":
        return [{"party_id": p, "declarations_limit": lim, "declarations_count": cnt}
                for (_e, p, _n, _g, _y, _s, _d, lim, cnt) in DOCTORS if lim is not None]
    return []


def doctor_by_employee(employee_id):
    return next((d for d in DOCTORS if d[0] == employee_id), None)


def employee_minimal(employee_id):
    d = doctor_by_employee(employee_id)
    if not d:
        return None
    e, p, n, *_rest = d
    return {"id": e, "position": "P2", "speciality": d[5],
            "party": {"id": p, "no_tax_id": False, "last_name": n[0], "first_name": n[1], "second_name": n[2],
                      "email": "doctor@example.ua", "phones": [{"type": "MOBILE", "number": "+380501112233"}]}}


def division_declaration(division_id):
    d = next((x for x in DIVISIONS if x["id"] == division_id), None)
    if not d:
        return None
    b = _division_bulk(d)
    return {k: b[k] for k in ("id", "legal_entity_id", "name", "addresses", "phones", "email", "type", "location", "status")}


def legal_entity_msp(le_id):
    le = next((x for x in LEGAL_ENTITIES if x["id"] == le_id), None)
    b = _legal_entity_bulk(le)
    return {"id": le["id"], "name": b["name"], "short_name": b["short_name"], "legal_form": "430", "public_name": b["public_name"],
            "edrpou": b["edrpou"], "status": "ACTIVE", "email": b["email"], "phones": b["phones"], "addresses": b["addresses"],
            "licenses": [{"license_number": "АЕ 123456", "issued_by": "МОЗ України", "issued_date": "2018-03-01",
                          "active_from_date": "2018-03-01", "what_licensed": "Медична практика", "order_no": "МОЗ-456"}]}


# ----------------------------------------------------------------------------
# Пацієнти (персони стенду)
# ----------------------------------------------------------------------------

def verification_block(kind="adult"):
    if kind == "unverified":
        return {"verification_status": "NOT_VERIFIED", "details": {
            "drfo": {"verification_status": "NOT_VERIFIED", "verification_reason": "AUTO", "result": 2},
            "dracs_death": {"verification_status": "VERIFIED", "verification_reason": "AUTO"},
            "nhs": {"verification_status": "NOT_VERIFIED", "verification_reason": "MANUAL_NOT_VERIFIED",
                    "verification_comment": "Бракує копії паспорта і РНОКПП пацієнта"},
            "unzr": {"verification_status": "VERIFICATION_NEEDED", "verification_reason": "AUTO", "status": 0},
            "mvs_passport": {"verification_status": "NOT_VERIFIED", "verification_reason": "AUTO", "status": 2},
            "dms_passport": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"},
            "dracs_birth": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"},
            "dracs_name_change": {"verification_status": "VERIFIED", "verification_reason": "AUTO"},
            "legal_capacity": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"}}}
    if kind == "teen":
        return {"verification_status": "VERIFIED", "details": {
            "drfo": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"},
            "dracs_death": {"verification_status": "VERIFIED", "verification_reason": "AUTO"},
            "nhs": {"verification_status": "VERIFIED", "verification_reason": "AUTO"},
            "unzr": {"verification_status": "VERIFIED", "verification_reason": "AUTO", "status": 1},
            "mvs_passport": {"verification_status": "VERIFIED", "verification_reason": "AUTO_ONLINE", "status": 1},
            "dms_passport": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"},
            "dracs_birth": {"verification_status": "VERIFIED", "verification_reason": "AUTO_ONLINE"},
            "dracs_name_change": {"verification_status": "VERIFIED", "verification_reason": "AUTO"},
            "legal_capacity": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"}}}
    return {"verification_status": "VERIFIED", "details": {
        "drfo": {"verification_status": "VERIFIED", "verification_reason": "AUTO", "result": 0},
        "dracs_death": {"verification_status": "VERIFIED", "verification_reason": "AUTO"},
        "nhs": {"verification_status": "VERIFIED", "verification_reason": "MANUAL_CONFIRMED",
                "verification_comment": "Підтверджено за копіями документів"},
        "unzr": {"verification_status": "VERIFIED", "verification_reason": "AUTO", "status": 1},
        "mvs_passport": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"},
        "dms_passport": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"},
        "dracs_birth": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"},
        "dracs_name_change": {"verification_status": "VERIFIED", "verification_reason": "MANUAL_CONFIRMED",
                              "verification_comment": "Пацієнт не змінював ПІБ"},
        "legal_capacity": {"verification_status": "VERIFICATION_NOT_NEEDED", "verification_reason": "AUTO_DATA_ABSENT"}}}


PERSONAS = {
    "olena": {
        "title": "Олена, 41 рік — чинна декларація, запит лікаря на підпис, усі дані заповнені",
        "person": {
            "first_name": "Олена", "last_name": "Іваненко", "second_name": "Петрівна", "birth_date": "1985-03-14",
            "birth_country": "Україна", "birth_settlement": "Вінниця", "gender": "FEMALE", "email": "olena.ivanenko@example.com",
            "tax_id": "3126509816", "no_tax_id": False, "secret": "Барвінок", "unzr": "19850314-00064",
            "preferred_way_communication": "phone",
            "documents": [
                {"type": "NATIONAL_ID", "number": "001234567", "issued_by": "4610", "issued_at": "2019-05-20",
                 "expiration_date": "2029-05-20"},
                {"type": "TAX_ID", "number": "3126509816", "issued_by": "ДПС України", "issued_at": "2001-04-02"}],
            "addresses": [address("RESIDENCE", "s-kyiv", "Ніжинська", "15", "23", "02090"),
                          address("REGISTRATION", "s-vinnytsia", "Соборна", "8", "4", "21000")],
            "phones": [{"type": "MOBILE", "number": "+380503410870"}, {"type": "LAND_LINE", "number": "+380442345678"}],
            "emergency_contact": {"first_name": "Петро", "last_name": "Іваненко", "second_name": "Миколайович",
                                  "phones": [{"type": "MOBILE", "number": "+380671234567"}]},
        },
        "verification": "adult",
        "auth_methods": [("OTP", "+380503410870", "Мій телефон"), ("OFFLINE", None, None)],
        "declaration": ("emp-koval", "div-pechersk-1", "active"),
        "old_declarations": [("emp-bondar", "div-boryspil", "terminated", "auto_new_declaration")],
        "declaration_requests": [("emp-melnyk", "div-pechersk-2", "NEW", "MIS")],
        "person_requests": ["SIGNED"],
        "pending_documents": [],
    },
    "maksym": {
        "title": "Максим, 15 років — без декларації, свідоцтво про народження, без телефону",
        "person": {
            "first_name": "Максим", "last_name": "Гончаренко", "second_name": "Андрійович",
            "birth_date": (date.today().replace(year=date.today().year - 15) - timedelta(days=40)).isoformat(),
            "birth_country": "Україна", "birth_settlement": "Львів", "gender": "MALE", "email": None,
            "tax_id": None, "no_tax_id": True, "secret": "Карпати", "unzr": None, "preferred_way_communication": None,
            "documents": [{"type": "BIRTH_CERTIFICATE", "number": "І-СГ 123456", "issued_by": "Галицький відділ ДРАЦС м. Львова",
                           "issued_at": "2011-09-01"},
                          {"type": "NATIONAL_ID", "number": "009876543", "issued_by": "4611", "issued_at": "2025-03-01",
                           "expiration_date": "2029-03-01"}],
            "addresses": [address("RESIDENCE", "s-lviv", "Городоцька", "55", None, "79000")],
            "phones": [],
            "emergency_contact": {"first_name": "Андрій", "last_name": "Гончаренко", "second_name": None,
                                  "phones": [{"type": "MOBILE", "number": "+380931112233"}]},
        },
        "verification": "teen",
        "auth_methods": [("OFFLINE", None, None)],
        "declaration": None, "old_declarations": [], "declaration_requests": [], "person_requests": [],
        "pending_documents": [],
    },
    "taras": {
        "title": "Тарас, 34 роки — дані не верифіковано, потрібні копії документів, запит на зміну даних NEW",
        "person": {
            "first_name": "Тарас", "last_name": "Бойко", "second_name": None, "birth_date": "1992-11-02",
            "birth_country": "Україна", "birth_settlement": "Бориспіль", "gender": "MALE", "email": None,
            "tax_id": "3397101234", "no_tax_id": False, "secret": "Дніпро", "unzr": None, "preferred_way_communication": "email",
            "documents": [{"type": "PASSPORT", "number": "КВ123456", "issued_by": "Бориспільським МВ ГУ МВС України в Київській обл.",
                           "issued_at": "2008-12-10"}],
            "addresses": [address("RESIDENCE", "s-boryspil", "Київський Шлях", "77", "12", "08300")],
            "phones": [{"type": "MOBILE", "number": "+380931234455"}],
            "emergency_contact": {"first_name": "Ганна", "last_name": "Бойко", "second_name": "Іванівна",
                                  "phones": [{"type": "MOBILE", "number": "+380671112244"}]},
        },
        "verification": "unverified",
        "auth_methods": [("OTP", "+380931234455", None)],
        "declaration": ("emp-bondar", "div-boryspil", "pending_verification"),
        "old_declarations": [], "declaration_requests": [], "person_requests": ["NEW"],
        "pending_documents": ["PASSPORT", "TAX_ID"],
    },
}


def mask_phone(number):
    return number[:6] + "*****" + number[-2:] if number else None


def declaration_content_html(person, employee, division, legal_entity, number):
    p = person
    return ("<html><head><meta charset='utf-8'><style>body{font-family:serif;padding:24px;max-width:760px}"
            "h1{font-size:18px;text-align:center}td{padding:4px 8px;vertical-align:top}</style></head><body>"
            f"<h1>ДЕКЛАРАЦІЯ про вибір лікаря, який надає первинну медичну допомогу № {number}</h1>"
            "<table>"
            f"<tr><td>Пацієнт</td><td>{p.get('last_name')} {p.get('first_name')} {p.get('second_name') or ''}</td></tr>"
            f"<tr><td>Дата народження</td><td>{p.get('birth_date')}</td></tr>"
            f"<tr><td>Лікар</td><td>{employee['party']['last_name']} {employee['party']['first_name']} "
            f"{employee['party']['second_name'] or ''}</td></tr>"
            f"<tr><td>Надавач</td><td>{legal_entity['name']}</td></tr>"
            f"<tr><td>Місце надання послуг</td><td>{division['name']}</td></tr>"
            "</table><p>Я, пацієнт, підтверджую достовірність наданих даних і даю згоду на обробку персональних даних.</p>"
            "<script>document.body.dataset.injected='1'</script></body></html>")


# ----------------------------------------------------------------------------
# Сама імітація
# ----------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status, message, type_="request_error", invalid=None):
        super().__init__(message)
        self.status, self.message, self.type, self.invalid = status, message, type_, invalid


class FakeEhealth:
    """Стан ЕСОЗ стенду: персони, токени, декларації, запити, файли. Потокобезпечний."""

    def __init__(self, storage_base, token_ttl=1800):
        self.lock = threading.RLock()
        self.storage_base = storage_base.rstrip("/")
        self.token_ttl = token_ttl
        self.faults = []          # [{method, path (regex), status, body|raw, delay, times}]
        self.calls = []           # журнал викликів (метод, шлях, статус)
        self.codes = {}           # code -> {persona, scope, expires}
        self.tokens = {}          # access -> {persona, expires, refresh}
        self.refresh_tokens = {}  # refresh -> persona
        self.nonces = {}
        self.otp = {}             # request_id -> {persona, phone, alias, code, status}
        self.uploads = {}         # storage key -> {persona, type, bytes}
        self.people = {}
        for key in PERSONAS:
            self.reset_persona(key)

    # ---------------- персони ----------------
    def reset_persona(self, key):
        spec = copy.deepcopy(PERSONAS[key])
        person_id = "person-" + key
        person = dict(spec["person"], id=person_id)
        state = {"key": key, "title": spec["title"], "person": person, "verification": verification_block(spec["verification"]),
                 "auth_methods": [], "declarations": [], "declaration_requests": [], "person_requests": [],
                 "pending_documents": list(spec["pending_documents"]), "apps": []}
        for i, (typ, phone, alias) in enumerate(spec["auth_methods"]):
            state["auth_methods"].append({"id": f"am-{key}-{i}", "type": typ, "phone_number": phone, "alias": alias,
                                          "is_active": True, "started_at": "2024-01-15 10:00:00.000000",
                                          "inserted_by": person_id, "person_id": person_id,
                                          "inserted_at": "2024-01-15T10:00:00.000Z", "updated_at": "2024-01-15T10:00:00.000Z"})
        if spec["declaration"]:
            emp, div, status = spec["declaration"]
            self._add_declaration(state, emp, div, status, signed_days_ago=420)
        for emp, div, status, reason in spec["old_declarations"]:
            self._add_declaration(state, emp, div, status, signed_days_ago=1500, reason=reason)
        for emp, div, status, channel in spec["declaration_requests"]:
            self._add_declaration_request(state, emp, div, status, channel)
        for status in spec["person_requests"]:
            self._add_person_request(state, status, changes={"email": "new.email@example.com"} if status == "NEW" else {})
        state["apps"] = [
            {"id": f"app-{key}-pis", "client_name": "Плексі (SimplexMed)", "client_id": "sandbox-client",
             "scope": " ".join(list(DICTIONARIES["SCOPES"])[:21]), "user_id": "user-" + key, "applicant_user_id": "user-" + key,
             "created_at": "2026-09-01T08:00:00Z", "updated_at": "2026-10-01T08:00:00Z"},
            {"id": f"app-{key}-other", "client_name": "Мій Лікар 24/7", "client_id": "other-client",
             "scope": "person:details_pis declaration:read_pis patients:read", "user_id": "user-" + key,
             "applicant_user_id": "user-" + key, "created_at": "2025-02-11T12:30:00Z", "updated_at": "2025-02-11T12:30:00Z"},
        ]
        with self.lock:
            self.people[key] = state
        return state

    def create_persona_from_signup(self, person):
        key = "new-" + uuid.uuid4().hex[:6]
        person = dict(person, id="person-" + key)
        PERSONAS[key] = {"title": f"Зареєстровано на стенді: {person.get('last_name')} {person.get('first_name')}",
                         "person": person, "verification": "unverified", "auth_methods": [
                             (m.get("type", "OTP"), m.get("phone_number"), None) for m in person.get("authentication_methods") or []],
                         "declaration": None, "old_declarations": [], "declaration_requests": [], "person_requests": [],
                         "pending_documents": ["PASSPORT"] if any(d.get("type") == "PASSPORT" for d in person.get("documents") or [])
                         else []}
        PERSONAS[key]["person"].pop("authentication_methods", None)
        self.reset_persona(key)
        return key

    def _add_declaration(self, state, employee_id, division_id, status, signed_days_ago=0, reason=None):
        employee = employee_minimal(employee_id)
        division = division_declaration(division_id)
        le = legal_entity_msp(division["legal_entity_id"])
        signed = NOW() - timedelta(days=signed_days_ago)
        number = "0000-" + uuid.uuid4().hex[:4].upper() + "-" + uuid.uuid4().hex[:4].upper()
        decl = {"id": uid(), "declaration_number": number, "start_date": signed.date().isoformat(),
                "end_date": (signed.date() + timedelta(days=365 * 20)).isoformat() if status != "terminated"
                else (signed.date() + timedelta(days=600)).isoformat(),
                "signed_at": iso(signed), "status": status, "scope": "family_doctor",
                "declaration_request_id": uid(), "inserted_at": iso(signed), "updated_at": iso(signed),
                "reason": reason, "reason_description": None,
                "_employee": employee, "_division": division, "_legal_entity": le,
                "content": declaration_content_html(state["person"], employee, division, le, number)}
        state["declarations"].append(decl)
        return decl

    def _data_to_be_signed(self, state, req):
        person = {k: v for k, v in state["person"].items()}
        person.update(patient_signed=False, process_disclosure_data_consent=True,
                      authentication_methods=[{"type": m["type"], "phone_number": mask_phone(m.get("phone_number"))}
                                              for m in state["auth_methods"] if m["is_active"] and m["type"] in ("OTP", "OFFLINE")])
        return {"id": req["id"], "status": req["status"], "declaration_number": req["declaration_number"],
                "declaration_id": req["declaration_id"], "start_date": req["start_date"], "end_date": req["end_date"],
                "content": req["content"], "channel": req["channel"], "person": person,
                "employee": req["_employee"], "legal_entity": req["_legal_entity"], "division": req["_division"],
                "seed": req["seed"], "scope": "family_doctor"}

    def _add_declaration_request(self, state, employee_id, division_id, status="NEW", channel="PIS"):
        employee = employee_minimal(employee_id)
        division = division_declaration(division_id)
        if not employee or not division:
            raise ApiError(409, "Employee doesn’t exist")
        le = legal_entity_msp(division["legal_entity_id"])
        number = "0000-" + uuid.uuid4().hex[:4].upper() + "-" + uuid.uuid4().hex[:4].upper()
        req = {"id": uid(), "declaration_number": number, "declaration_id": uid(), "start_date": date.today().isoformat(),
               "end_date": (date.today() + timedelta(days=365 * 20)).isoformat(), "scope": "family doctor",
               "status": status, "channel": channel, "status_reason": None, "seed": uuid.uuid4().hex,
               "inserted_at": iso(NOW()), "_employee": employee, "_division": division, "_legal_entity": le,
               "content": declaration_content_html(state["person"], employee, division, le, number)}
        state["declaration_requests"].append(req)
        return req

    def _add_person_request(self, state, status, changes):
        person = dict(state["person"], **changes)
        req = {"id": uid(), "status": status, "channel": "PIS", "inserted_at": iso(NOW() - timedelta(days=3)),
               "updated_at": iso(NOW() - timedelta(days=3)), "patient_signed": status in ("APPROVED", "SIGNED"),
               "process_disclosure_data_consent": True,
               "content": "<html><body><h3>Запит на зміну персональних даних</h3><p>Електронна пошта: "
                          f"{person.get('email') or '—'}</p></body></html>",
               "person": person, "_documents": [], "_changes": changes}
        state["person_requests"].append(req)
        return req

    # ---------------- транспорт ----------------
    def request(self, method, url, headers=None, body=None, timeout=60):
        from ehealth_pis.transport import HttpResponse  # імпорт тут: пакет у sys.path стенду
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        parsed = urlparse(url)
        # хости стенду мають префікс /__eh/api або /__eh/auth — шляхи API ті самі, що в специфікації
        path = re.sub(r"^/__eh/(api|auth)(?=/)", "", parsed.path)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        status, payload, raw = 500, None, None
        fault = self._take_fault(method, path)
        if fault:
            if fault.get("delay"):
                time.sleep(min(float(fault["delay"]), 120))
            if fault.get("network"):
                self._log(method, path, 0)
                raise OSError("Sandbox: network error injected")
            if fault.get("status"):
                status = int(fault["status"])
                raw = fault.get("raw")
                payload = fault.get("body")
                if raw is None and payload is None:
                    payload = {"meta": {"code": status}, "error": {"type": fault.get("type", "request_error"),
                                                                     "message": fault.get("message", "Injected error")}}
                self._log(method, path, status)
                return HttpResponse(status, raw.encode() if isinstance(raw, str) else json.dumps(payload).encode(),
                                    {"Content-Type": "text/html" if raw else "application/json"})
        try:
            with self.lock:
                status, payload = self._dispatch(method, path, query, headers, body)
        except ApiError as e:
            status = e.status
            payload = {"meta": {"code": e.status}, "error": {"type": e.type, "message": e.message,
                                                             **({"invalid": e.invalid} if e.invalid else {})}}
        self._log(method, path, status)
        if isinstance(payload, (bytes, bytearray)):
            return HttpResponse(status, bytes(payload), {"Content-Type": "application/octet-stream"})
        return HttpResponse(status, b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                            {"Content-Type": "application/json"})

    def _log(self, method, path, status):
        self.calls.append({"t": time.strftime("%H:%M:%S"), "method": method, "path": path, "status": status})
        del self.calls[:-300]

    def _take_fault(self, method, path):
        with self.lock:
            for f in self.faults:
                if f.get("method") and f["method"].upper() != method.upper():
                    continue
                if not re.search(f.get("path", ".*"), path):
                    continue
                if f.get("times") is not None:
                    f["times"] -= 1
                    if f["times"] <= 0:
                        self.faults.remove(f)
                return dict(f)
        return None

    # ---------------- маршрутизація ----------------
    def _dispatch(self, method, path, q, headers, body):
        if path.startswith("/__storage/"):
            return self._storage_put(method, path, body)
        if not headers.get("api-key"):
            raise ApiError(401, "API-KEY header required", "access_denied")
        data = json.loads(body.decode("utf-8")) if body else {}
        m = method.upper()

        if path == "/oauth/nonce" and m == "POST":
            nonce = uuid.uuid4().hex
            jwt = ".".join(base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip("=") for x in (
                {"alg": "HS512", "typ": "JWT"}, {"aud": "mithril-login", "nonce": nonce, "iss": "EHealth",
                                                 "exp": int(time.time()) + 600})) + ".sandbox"
            self.nonces[jwt] = time.time()
            return 200, {"meta": {"code": 200}, "data": {"token": jwt}}
        if path == "/oauth/tokens" and m == "POST":
            return self._tokens(data.get("token") or {})
        if path == "/auth/logout" and m == "POST":
            token = self._bearer(headers)
            info = self.tokens.pop(token, None)
            if info:
                self.refresh_tokens.pop(info["refresh"], None)
            return 200, {"meta": {"code": 200}, "data": {}}

        if path.startswith("/api/v2/dictionaries"):
            return 200, {"meta": {"code": 200}, "data": dictionary_v2(q.get("name"))}
        if path.startswith("/api/uaddresses/"):
            return self._addresses(path, q)
        if path.startswith("/api/pis/bulk/"):
            name = path.rsplit("/", 1)[1]
            items = bulk_data(name)
            return 200, {"meta": {"code": 200, "date": iso(NOW())}, "data": items}

        if path.startswith("/api/pis/"):
            state = self._person_state(headers)
            return self._pis(m, path[len("/api/pis/"):], q, data, state)
        raise ApiError(404, "not found", "not_found")

    def _bearer(self, headers):
        auth = headers.get("authorization", "")
        return auth[7:] if auth.startswith("Bearer ") else ""

    def _person_state(self, headers):
        token = self._bearer(headers)
        info = self.tokens.get(token)
        if not info or info["expires"] < time.time():
            raise ApiError(401, "Invalid access token", "access_denied")
        return self.people[info["persona"]]

    def issue_code(self, persona, scope):
        code = "code-" + uuid.uuid4().hex
        self.codes[code] = {"persona": persona, "scope": scope, "expires": time.time() + 300}
        return code

    def _token_response(self, persona, scope, refresh=None, status=201):
        access = "at-" + uuid.uuid4().hex
        refresh = refresh or ("rt-" + uuid.uuid4().hex)
        self.tokens[access] = {"persona": persona, "expires": time.time() + self.token_ttl, "refresh": refresh}
        self.refresh_tokens[refresh] = {"persona": persona, "scope": scope}
        details = {"scope": scope, "client_id": "sandbox-client", "grant_type": "authorization_code",
                   "redirect_uri": "http://localhost", "app_id": uid()}
        if status == 201 and not refresh.startswith("keep-"):
            details["refresh_token"] = refresh
        return 201, {"meta": {"code": 201}, "data": {
            "value": access, "user_id": "user-" + persona, "user": {"person_id": self.people[persona]["person"]["id"]},
            "name": "access_token", "id": uid(), "expires_at": int(time.time() + self.token_ttl), "details": details}}

    def _tokens(self, t):
        if t.get("grant_type") == "authorization_code":
            info = self.codes.pop(t.get("code"), None)
            if not info or info["expires"] < time.time():
                raise ApiError(401, "Invalid authorization code.", "access_denied")
            if not t.get("client_secret") or not t.get("redirect_uri"):
                raise ApiError(422, "required property client_secret was not present", "validation_failed")
            return self._token_response(info["persona"], t.get("scope") or info["scope"])
        if t.get("grant_type") == "refresh_token":
            info = self.refresh_tokens.get(t.get("refresh_token"))
            if not info:
                raise ApiError(401, "Invalid refresh token.", "access_denied")
            status, payload = self._token_response(info["persona"], info["scope"], refresh=t["refresh_token"])
            payload["data"]["details"].pop("refresh_token", None)  # Access_Token_1: без refresh_token
            payload["data"]["name"] = "access_token"
            return status, payload
        raise ApiError(422, "Grant type is not allowed.", "validation_failed")

    def _addresses(self, path, q):
        name = (q.get("name") or "").upper()
        if path == "/api/uaddresses/regions":
            return 200, {"data": [r for r in REGIONS if name in r["region"]], "paging": {"page_number": 1, "total_pages": 1}}
        m = re.fullmatch(r"/api/uaddresses/regions/([^/]+)/districts", path)
        if m:
            return 200, {"data": [{"id": d["id"], "district": d["district"]} for d in DISTRICTS
                                  if d["region_id"] == m.group(1) and name in d["district"]]}
        m = re.fullmatch(r"/api/uaddresses/districts/([^/]+)/settlements", path)
        if m:
            return 200, {"data": [{"id": s["id"], "settlement_name": s["name"]} for s in SETTLEMENTS
                                  if s["district_id"] == m.group(1) and name in s["name"]]}
        if path == "/api/uaddresses/districts":
            region = (q.get("region") or "").upper()
            return 200, {"data": [d for d in DISTRICTS if region in d["region"] and name in d["district"]]}
        if path == "/api/uaddresses/settlements":
            region = (q.get("region") or "").upper()
            items = [settlement_view(s) for s in SETTLEMENTS]
            items = [s for s in items if (not region or region in s["region"]) and name in s["name"]]
            return 200, {"data": items, "paging": {"page_number": 1, "page_size": 50, "total_entries": len(items), "total_pages": 1}}
        if path == "/api/uaddresses/streets":
            items = [{"id": s["id"], "settlement_id": s["settlement_id"], "type": s["type"], "name": s["name"], "aliases": [s["name"]]}
                     for s in STREETS if s["settlement_id"] == q.get("settlement_id") and name.lower() in s["name"].lower()]
            return 200, {"data": items}
        raise ApiError(404, "not found", "not_found")

    @staticmethod
    def _page(items, q):
        size = max(1, min(int(q.get("page_size") or 50), 300))
        page = max(1, int(q.get("page") or q.get("page_number") or 1))
        total = len(items)
        return {"meta": {"code": 200, "type": "list"}, "data": items[(page - 1) * size: page * size],
                "paging": {"page_number": page, "page_size": size, "total_entries": total,
                           "total_pages": max(1, (total + size - 1) // size)}}

    def _find(self, items, item_id):
        item = next((x for x in items if x["id"] == item_id), None)
        if not item:
            raise ApiError(404, "not found", "not_found")
        return item

    @staticmethod
    def _public(obj):
        return {k: v for k, v in obj.items() if not k.startswith("_")}

    def _decl_list_item(self, d):
        return {"id": d["id"], "declaration_number": d["declaration_number"], "start_date": d["start_date"],
                "end_date": d["end_date"], "status": d["status"], "reason": d["reason"],
                "reason_description": d["reason_description"], "person": {"id": "x"},
                "employee": {"id": d["_employee"]["id"]}, "division": {"id": d["_division"]["id"]},
                "legal_entity": {"id": d["_legal_entity"]["id"]}, "inserted_at": d["inserted_at"], "updated_at": d["updated_at"]}

    def _decl_details(self, state, d):
        out = self._public(d)
        out.update(person={"id": state["person"]["id"]}, employee={"id": d["_employee"]["id"]},
                   division={"id": d["_division"]["id"]}, legal_entity={"id": d["_legal_entity"]["id"]})
        return out

    def _decl_req_details(self, state, r):
        out = {k: r[k] for k in ("id", "declaration_number", "declaration_id", "start_date", "end_date", "scope", "status",
                                 "status_reason", "channel")}
        doc = doctor_by_employee(r["_employee"]["id"])
        out.update(current_declaration_count=doc[8] if doc and doc[8] is not None else 0,
                   system_declaration_limit=doc[7] if doc and doc[7] is not None else 0,
                   patient_id=state["person"]["id"], employee_id=r["_employee"]["id"],
                   legal_entity_id=r["_legal_entity"]["id"], division_id=r["_division"]["id"])
        if r["status"] == "NEW":
            out["data_to_be_signed"] = self._data_to_be_signed(state, r)
        return out

    def _pis(self, m, rest, q, data, state):
        person = state["person"]
        if rest == "person" and m == "GET":
            return 200, {"meta": {"code": 200}, "data": dict(person, verification=state["verification"])}
        if rest == "person/verification" and m == "GET":
            return 200, {"meta": {"code": 200}, "data": {"person_verification": state["verification"]}}
        if rest == "person/authentication_methods" and m == "GET":
            return 200, {"meta": {"code": 200}, "data": [
                {k: v for k, v in am.items() if v is not None} for am in state["auth_methods"] if am["is_active"]]}

        # --- методи автентифікації ---
        if rest == "authentication_method_requests" and m == "POST":
            am = data.get("authentication_method") or {}
            phone = am.get("phone_number") or ""
            if am.get("type") != "OTP" or not re.fullmatch(r"\+380\d{9}", phone):
                raise ApiError(422, "Unverified phone number", "unverified")
            req_id = uid()
            self.otp[req_id] = {"persona": state["key"], "phone": phone, "alias": am.get("alias"), "code": "1234", "status": "NEW"}
            current = [{"type": x["type"], "phone_number": mask_phone(x.get("phone_number"))}
                       for x in state["auth_methods"] if x["is_active"] and x["type"] in ("OTP", "OFFLINE")]
            return 201, {"meta": {"code": 201}, "data": {"id": req_id, "status": "NEW", "channel": "PIS"},
                         "urgent": {"authentication_method_current": current or None}}
        mm = re.fullmatch(r"authentication_method_requests/([^/]+)/actions/(approve|resend_otp)", rest)
        if mm:
            req = self.otp.get(mm.group(1))
            if not req or req["persona"] != state["key"]:
                raise ApiError(404, "not found", "not_found")
            if mm.group(2) == "resend_otp":
                return 200, {"meta": {"code": 200}, "data": {"id": uid(), "status": "NEW", "active": True,
                                                              "code_expired_at": iso(NOW() + timedelta(minutes=5))}}
            if req["status"] != "NEW":
                raise ApiError(403, "Only authentication method request with NEW status is allowed", "forbidden")
            if str(data.get("verification_code")) != req["code"]:
                raise ApiError(422, "Invalid verification code", "validation_failed",
                               invalid=[{"entry": "$.verification_code", "entry_type": "json_data_property",
                                         "rules": [{"rule": "invalid", "description": "Invalid verification code"}]}])
            req["status"] = "COMPLETED"
            state["auth_methods"].append({"id": uid(), "type": "OTP", "phone_number": req["phone"], "alias": req["alias"],
                                          "is_active": True, "started_at": NOW().strftime("%Y-%m-%d %H:%M:%S.000000"),
                                          "inserted_by": person["id"], "person_id": person["id"],
                                          "inserted_at": iso(NOW()), "updated_at": iso(NOW())})
            return 201, {"meta": {"code": 201}, "data": {"id": mm.group(1), "status": "COMPLETED", "channel": "PIS"}}
        mm = re.fullmatch(r"authentication_methods/([^/]+)(/actions/deactivate)?", rest)
        if mm and m == "PATCH":
            am = self._find(state["auth_methods"], mm.group(1))
            if mm.group(2):
                am["is_active"] = False
                am["ended_at"] = NOW().strftime("%Y-%m-%d %H:%M:%S.000000")
            else:
                am["alias"] = data.get("alias")
                am["updated_at"] = iso(NOW())
            return 201, {"meta": {"code": 201}, "data": am}

        # --- копії документів ---
        if rest == "documents" and m == "POST":
            return 201, {"meta": {"code": 201}, "data": [
                {"type": t, "url": f"{self.storage_base}/__storage/{state['key']}/{t}/{uuid.uuid4().hex}"}
                for t in state["pending_documents"]]}
        if rest == "documents/actions/complete" and m == "PATCH":
            uploaded = {u["type"] for u in self.uploads.values() if u["persona"] == state["key"]}
            state["pending_documents"] = [t for t in state["pending_documents"] if t not in uploaded]
            if not state["pending_documents"]:
                state["verification"]["details"]["nhs"].update(verification_status="IN_REVIEW", verification_reason="AUTO",
                                                               verification_comment=None)
            return 200, {"meta": {"code": 200}, "data": [
                {"type": t, "url": f"{self.storage_base}/__storage/{state['key']}/{t}/{uuid.uuid4().hex}"}
                for t in state["pending_documents"]]}

        # --- запити на зміну персональних даних ---
        if rest == "person_requests" and m == "GET":
            items = [{"id": r["id"], "status": r["status"], "channel": r["channel"], "inserted_at": r["inserted_at"],
                      "updated_at": r["updated_at"], "person": {k: r["person"].get(k) for k in ("first_name", "last_name", "second_name")}}
                     for r in reversed(state["person_requests"])
                     if (not q.get("status") or r["status"] == q["status"]) and (not q.get("channel") or r["channel"] == q["channel"])]
            return 200, self._page(items, q)
        if rest == "person_requests" and m == "POST":
            new_person = data.get("person") or {}
            missing = [f for f in ("first_name", "last_name", "birth_date", "birth_country", "birth_settlement", "gender",
                                   "secret", "documents", "addresses", "emergency_contact") if not new_person.get(f)]
            if missing:
                raise ApiError(422, "Validation failed", "validation_failed", invalid=[
                    {"entry": f"$.person.{f}", "entry_type": "json_data_property",
                     "rules": [{"rule": "required", "description": "required property " + f + " was not present"}]}
                    for f in missing])
            if any(r["status"] == "NEW" for r in state["person_requests"]):
                pass  # Система дозволяє, попередній NEW стане CANCELLED
            for r in state["person_requests"]:
                if r["status"] in ("NEW", "APPROVED"):
                    r["status"] = "CANCELLED"
            changes = {k: v for k, v in new_person.items() if person.get(k) != v}
            req = self._add_person_request(state, "NEW", changes)
            req["inserted_at"] = req["updated_at"] = iso(NOW())
            req["patient_signed"] = False
            req["content"] = ("<html><body><h3>Запит на зміну персональних даних</h3><ul>"
                              + "".join(f"<li>{k}</li>" for k in changes) + "</ul></body></html>")
            docs = []
            old_numbers = {(d.get("type"), d.get("number")) for d in person.get("documents") or []}
            for d in new_person.get("documents") or []:
                if (d.get("type"), d.get("number")) not in old_numbers:
                    docs.append(d.get("type"))
            if "first_name" in changes or "last_name" in changes:
                docs.append("NAME_CHANGE_CERTIFICATE")
            req["_documents"] = [{"type": t, "is_uploaded": False,
                                  "url": f"{self.storage_base}/__storage/{state['key']}/{t}/{req['id']}"} for t in docs]
            urgent = {"documents": [{"type": d["type"], "url": d["url"]} for d in req["_documents"]]}
            return 201, {"meta": {"code": 201}, "data": self._person_request_details(req), "urgent": urgent}
        mm = re.fullmatch(r"person_requests/([^/]+)(/actions/(complete|reject))?", rest)
        if mm:
            req = self._find(state["person_requests"], mm.group(1))
            action = mm.group(3)
            if not action and m == "GET":
                for d in req["_documents"]:
                    d["is_uploaded"] = any(u["persona"] == state["key"] and u["type"] == d["type"] and req["id"] in k
                                           for k, u in self.uploads.items())
                urgent = {"documents": req["_documents"]} if req["_documents"] else {}
                if req["status"] == "SIGNED":
                    urgent["links"] = [{"type": "SIGNED_CONTENT", "url": f"{self.storage_base}/__storage/signed/{req['id']}"}]
                return 200, {"meta": {"code": 200}, "data": self._person_request_details(req), "urgent": urgent}
            if action == "reject" and m == "PATCH":
                if req["status"] not in ("NEW", "APPROVED"):
                    raise ApiError(409, "Invalid transition", "request_conflict")
                req["status"] = "REJECTED"
                req["updated_at"] = iso(NOW())
                return 200, {"meta": {"code": 200}, "data": self._person_request_details(req)}
            if action == "complete" and m == "PATCH":
                if req["status"] not in ("NEW", "APPROVED"):
                    raise ApiError(409, "Invalid transition", "request_conflict")
                if data.get("signed_content_encoding") != "base64":
                    raise ApiError(422, "required property signed_content_encoding was not present", "validation_failed")
                text = unsign(data.get("signed_content") or "")
                if text is None:
                    raise ApiError(422, "Invalid signed content", "validation_failed")
                try:
                    signed = json.loads(text)
                except ValueError:
                    raise ApiError(422, "Signed content is not a valid JSON", "validation_failed")
                if signed.get("id") != req["id"] or signed.get("patient_signed") is not True:
                    raise ApiError(422, "Signed content does not match the previously created content", "validation_failed")
                missing = [d["type"] for d in req["_documents"]
                           if not any(u["persona"] == state["key"] and u["type"] == d["type"] and req["id"] in k
                                      for k, u in self.uploads.items())]
                if missing:
                    raise ApiError(409, "Documents are not uploaded: " + ", ".join(missing), "request_conflict")
                req["status"] = "SIGNED"
                req["patient_signed"] = True
                req["updated_at"] = iso(NOW())
                state["person"].update({k: v for k, v in req["_changes"].items()})
                return 200, {"meta": {"code": 200}, "data": {"person_id": person["id"], "status": "SIGNED", "id": req["id"],
                                                             "updated_at": req["updated_at"]}}

        # --- декларації ---
        if rest == "declarations" and m == "GET":
            items = [self._decl_list_item(d) for d in sorted(state["declarations"], key=lambda d: d["signed_at"], reverse=True)
                     if not q.get("status") or d["status"] == q["status"]]
            return 200, self._page(items, q)
        mm = re.fullmatch(r"declarations/([^/]+)(/actions/terminate)?", rest)
        if mm:
            d = self._find(state["declarations"], mm.group(1))
            if mm.group(2) and m == "PATCH":
                if d["status"] not in ("active", "pending_verification"):
                    raise ApiError(409, "Invalid transition", "request_conflict")
                d.update(status="terminated", reason="manual_person", reason_description=data.get("reason_description"),
                         end_date=date.today().isoformat(), updated_at=iso(NOW()))
                out = self._public(d)
                out.update(person=dict(person), employee=d["_employee"], division=d["_division"], legal_entity=d["_legal_entity"])
                return 200, {"meta": {"code": 200}, "data": out}
            if m == "GET":
                urgent = {"links": [{"type": "SIGNED_CONTENT", "url": f"{self.storage_base}/__storage/signed/{d['id']}"}]}
                return 200, {"meta": {"code": 200}, "data": self._decl_details(state, d), "urgent": urgent}

        # --- запити на декларацію ---
        if rest == "declaration_requests" and m == "GET":
            items = [{"id": r["id"], "declaration_number": r["declaration_number"], "start_date": r["start_date"],
                      "end_date": r["end_date"], "channel": r["channel"], "status_reason": r["status_reason"],
                      "status": r["status"].lower(),
                      "person": {"id": person["id"], "first_name": person["first_name"], "last_name": person["last_name"],
                                 "second_name": person.get("second_name")},
                      "employee": {"id": r["_employee"]["id"], "position": r["_employee"]["position"],
                                   "party": {k: r["_employee"]["party"][k] for k in ("id", "first_name", "last_name", "second_name")}},
                      "legal_entity": {k: r["_legal_entity"][k] for k in ("id", "name", "short_name", "legal_form", "edrpou")},
                      "division": {k: r["_division"][k] for k in ("id", "name", "type", "status")}}
                     for r in reversed(state["declaration_requests"])
                     if (not q.get("status") or r["status"].lower() == q["status"].lower())
                     and (not q.get("channel") or r["channel"] == q["channel"])]
            return 200, self._page(items, q)
        if rest == "declaration_requests" and m == "POST":
            if state["verification"]["verification_status"] == "NOT_VERIFIED":
                raise ApiError(409, "Person is not verified", "request_conflict")
            doc = doctor_by_employee(data.get("employee_id"))
            if not doc:
                raise ApiError(409, "Employee doesn’t exist", "request_conflict")
            if doc[5] not in ("FAMILY_DOCTOR", "THERAPIST", "PEDIATRICIAN"):
                raise ApiError(409, "Invalid employee type", "request_conflict")
            age = _age(person["birth_date"])
            if (doc[5] == "THERAPIST" and age < 18) or (doc[5] == "PEDIATRICIAN" and age >= 18):
                raise ApiError(409, "Doctor speciality doesn't match patient's age", "request_conflict")
            for r in state["declaration_requests"]:
                if r["status"] == "NEW" and r["channel"] == "PIS":
                    r["status"], r["status_reason"] = "CANCELLED", "auto_new_declaration_request"
            req = self._add_declaration_request(state, data["employee_id"], data["division_id"], "NEW", "PIS")
            details = self._data_to_be_signed(state, req)
            out = dict(details, data_to_be_signed=self._data_to_be_signed(state, req))
            return 201, {"meta": {"code": 201}, "data": out}
        mm = re.fullmatch(r"declaration_requests/([^/]+)(/actions/(sign|reject))?", rest)
        if mm:
            req = self._find(state["declaration_requests"], mm.group(1))
            action = mm.group(3)
            if not action and m == "GET":
                current = next(({"type": a["type"], "number": mask_phone(a.get("phone_number"))} for a in state["auth_methods"]
                                if a["is_active"] and a["type"] in ("OTP", "OFFLINE")), {"type": "NA"})
                return 200, {"meta": {"code": 200}, "data": self._decl_req_details(state, req),
                             "urgent": {"authentication_method_current": current}}
            if req["status"] != "NEW":
                raise ApiError(409, "Invalid transition", "request_conflict")
            if action == "reject" and m == "PATCH":
                req.update(status="REJECTED", status_reason="manual_person")
                return 201, {"meta": {"code": 201}, "data": self._decl_req_details(state, req)}
            if action == "sign" and m == "PATCH":
                text = unsign(data.get("signed_content") or "")
                if text is None:
                    raise ApiError(422, "Invalid signed content", "validation_failed")
                try:
                    signed = json.loads(text)
                except ValueError:
                    raise ApiError(422, "data_to_be_signed 422 message: Signed content does not match the previously created content",
                                   "validation_failed")
                expected = self._data_to_be_signed(state, req)
                if (signed.get("id") != req["id"] or signed.get("seed") != req["seed"]
                        or (signed.get("person") or {}).get("patient_signed") is not True
                        or signed.get("content") != expected["content"]):
                    raise ApiError(422, "data_to_be_signed 422 message: Signed content does not match the previously created content",
                                   "validation_failed")
                if any(r["status"] in ("NEW", "APPROVED") for r in state["person_requests"]):
                    raise ApiError(409, "It is prohibited to sign declaration request when there is unfinished person request",
                                   "request_conflict")
                req["status"] = "SIGNED"
                for d in state["declarations"]:
                    if d["status"] in ("active", "pending_verification"):
                        d.update(status="terminated", reason="auto_new_declaration", end_date=date.today().isoformat())
                decl = self._add_declaration(state, req["_employee"]["id"], req["_division"]["id"],
                                             "active" if state["verification"]["verification_status"] == "VERIFIED"
                                             else "pending_verification")
                decl["id"] = req["declaration_id"]
                decl["declaration_number"] = req["declaration_number"]
                out = self._data_to_be_signed(state, req)
                out.update(status="SIGNED", data_to_be_signed=self._data_to_be_signed(state, req))
                out["employee"] = req["_employee"]
                return 201, {"meta": {"code": 201}, "data": out}

        # --- доступи (approvals) ---
        if rest == "apps" and m == "GET":
            return 200, self._page(state["apps"], q)
        mm = re.fullmatch(r"apps/([^/]+)", rest)
        if mm:
            app = self._find(state["apps"], mm.group(1))
            if m == "GET":
                return 200, {"meta": {"code": 200}, "data": app}
            if m == "DELETE":
                state["apps"].remove(app)
                return 204, None
        raise ApiError(404, "not found", "not_found")

    def _person_request_details(self, req):
        return {"id": req["id"], "status": req["status"], "channel": req["channel"], "inserted_at": req["inserted_at"],
                "updated_at": req["updated_at"], "patient_signed": req["patient_signed"],
                "process_disclosure_data_consent": req["process_disclosure_data_consent"], "content": req["content"],
                "person": req["person"]}

    def _storage_put(self, method, path, body):
        if method.upper() != "PUT":
            raise ApiError(405, "method not allowed")
        parts = path.split("/")  # /__storage/<persona>/<type>/<key>
        if len(parts) < 5 or parts[2] not in self.people:
            raise ApiError(404, "not found", "not_found")
        self.uploads[path] = {"persona": parts[2], "type": parts[3], "bytes": len(body or b"")}
        return 200, None


def _age(birth_date):
    b = date.fromisoformat(birth_date[:10])
    t = date.today()
    return t.year - b.year - ((t.month, t.day) < (b.month, b.day))
