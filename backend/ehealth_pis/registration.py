"""
Реєстрація пацієнта через КПІС (п.3.5 ТВ ПІС, метод "PIS. Patient sign-up").

Пацієнт підписує ЕП JSON {person, patient_signed, process_disclosure_data_consent, jwt},
де jwt — nonce з "Get nonce"; base64 підписаного контенту передається в user_data.
Тут — перевірка даних форми за п.3.5.4 до підпису і формування контенту для підпису.
"""

import json
import re
from datetime import date

TAX_ID_RE = re.compile(r"^[0-9]{10}$")
SECRET_RE = re.compile(r"^[A-Za-zА-Яа-яҐґЇїІіЄє0-9]{6,20}$")
UNZR_RE = re.compile(r"^[0-9]{8}-[0-9]{5}$")
PHONE_RE = re.compile(r"^\+38[0-9]{10}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Значення конфігураційних параметрів Системи (уточнюються на preprod)
NO_SELF_REGISTRATION_AGE = 14
FULL_LEGAL_CAPACITY_AGE = 18
# PIS_PERSON_REGISTRATION_DOCUMENT_TYPES — перелік ТВ ПІС v2 (наказ № 978), п.3.4.5.9.a
REGISTRATION_DOCUMENT_TYPES = (
    "PASSPORT", "NATIONAL_ID", "BIRTH_CERTIFICATE", "TEMPORARY_CERTIFICATE",
    "REFUGEE_CERTIFICATE", "PERMANENT_RESIDENCE_PERMIT", "COMPLEMENTARY_PROTECTION_CERTIFICATE",
    "TEMPORARY_PASSPORT", "BIRTH_CERTIFICATE_FOREIGN",
)


def _date(value):
    if not value or not DATE_RE.match(str(value)):
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def age_on(birth, today):
    return today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))


# п.3.5.4.8: поштові сервіси, заборонені рішеннями РНБО / НЦУ (перелік НСЗУ, nszu.gov.ua/gromadianam/onlain-formi).
# Блокуються також піддомени (напр. mail.yandex.ua) і будь-яка зона .ru.
BLOCKED_EMAIL_DOMAINS = frozenset("""
yandex.ua yandex.ru yandex.com yandex.by yandex.kz ya.ru ya.com mail.ru mail.ua inbox.ru list.ru bk.ru
rambler.ru aport.ru email.ru newmail.ru hotmail.ru sendmail.ru male.ru female.ru zmail.ru id.ru go.ru ok.ru
ru.ru nm.ru pisem.net mailru.com fromru.com hotbox.ru pochtamt.ru rbcmail.ru krovatka.net boom.ru narod.ru
by.ru vk.com vkontakte.ru lenta.ru autorambler.ru myrambler.ru ro.ru
""".split())


def email_domain_blocked(email):
    domain = email.rsplit("@", 1)[-1].strip().lower().rstrip(".")
    if domain.endswith(".ru") or domain == "ru":
        return True
    parts = domain.split(".")
    return any(".".join(parts[i:]) in BLOCKED_EMAIL_DOMAINS for i in range(len(parts) - 1))


def validate_person_request(person, today=None, for_update=False):
    """
    Повертає список помилок [(поле, текст)]; порожній список — дані коректні.
    for_update=True — зміна даних (п.3.10.1): без методу автентифікації і вікового порогу самореєстрації.
    """
    today = today or date.today()
    errors = []

    def need(field, label):
        if not str(person.get(field) or "").strip():
            errors.append((field, f"{label}: обов'язкове поле"))

    if not isinstance(person, dict):
        return [("person", "Дані пацієнта відсутні")]

    need("first_name", "Ім'я")
    need("last_name", "Прізвище")
    need("birth_country", "Країна народження")
    need("birth_settlement", "Місце народження")
    if person.get("gender") not in ("MALE", "FEMALE"):
        errors.append(("gender", "Стать: оберіть значення"))

    birth = _date(person.get("birth_date"))
    if not birth or birth >= today:
        errors.append(("birth_date", "Дата народження: вкажіть дату у форматі ДД.ММ.РРРР"))
    elif not for_update and age_on(birth, today) < NO_SELF_REGISTRATION_AGE:
        errors.append(("birth_date", f"Самостійна реєстрація можлива з {NO_SELF_REGISTRATION_AGE} років"))

    email = person.get("email")
    if email and not EMAIL_RE.match(email):
        errors.append(("email", "Електронна пошта: некоректний формат"))
    elif email and email_domain_blocked(email):
        errors.append(("email", "Електронна пошта: поштовий сервіс заборонено в Україні, вкажіть адресу іншого сервісу"))
    if person.get("no_tax_id") is not True:
        if not TAX_ID_RE.match(str(person.get("tax_id") or "")):
            errors.append(("tax_id", "РНОКПП: 10 цифр або позначка про відмову від РНОКПП"))
    elif person.get("tax_id"):
        errors.append(("tax_id", "РНОКПП не вказується разом із позначкою про відмову"))
    if not SECRET_RE.match(str(person.get("secret") or "")):
        errors.append(("secret", "Кодове слово: 6–20 літер або цифр"))
    if person.get("unzr") and not UNZR_RE.match(person["unzr"]):
        errors.append(("unzr", "УНЗР: формат РРРРММДД-ХХХХХ"))

    documents = person.get("documents") or []
    identity = [d for d in documents if d.get("type") in REGISTRATION_DOCUMENT_TYPES]
    # Реєстрація (п.3.5.4.12): рівно один документ; у наявного запису їх може бути кілька
    if (len(identity) != 1) if not for_update else (len(identity) < 1):
        errors.append(("documents", "Вкажіть один документ, що посвідчує особу"))
    for i, doc in enumerate(documents):
        prefix = f"documents[{i}]"
        if not doc.get("type"):
            errors.append((f"{prefix}.type", "Документ: оберіть тип"))
        if not str(doc.get("number") or "").strip():
            errors.append((f"{prefix}.number", "Документ: вкажіть серію та номер"))
        issued = _date(doc.get("issued_at"))
        if not issued or issued >= today or (birth and issued <= birth):
            errors.append((f"{prefix}.issued_at",
                           "Документ: дата видачі має бути раніше сьогодні та пізніше дати народження"))
        expires = _date(doc.get("expiration_date"))
        if doc.get("expiration_date") and (not expires or expires <= today):
            errors.append((f"{prefix}.expiration_date", "Документ: строк дії сплив або дата некоректна"))
    if birth and NO_SELF_REGISTRATION_AGE <= age_on(birth, today) < FULL_LEGAL_CAPACITY_AGE:
        capacity_docs = len(documents) - len(identity)
        if (capacity_docs != 1) if not for_update else (capacity_docs < 1):
            errors.append(("documents", "Для вашого віку додайте один документ, що підтверджує дієздатність"))

    addresses = person.get("addresses") or []
    residence = [a for a in addresses if a.get("type") == "RESIDENCE"]
    if len(residence) != 1:
        errors.append(("addresses", "Вкажіть адресу фактичного місця проживання"))
    for i, addr in enumerate(addresses):
        for field, label in (("country", "країна"), ("area", "область"), ("settlement", "населений пункт"),
                             ("settlement_type", "тип населеного пункту"), ("settlement_id", "населений пункт з довідника")):
            if not str(addr.get(field) or "").strip():
                errors.append((f"addresses[{i}].{field}", f"Адреса: {label} — обов'язково"))

    for i, phone in enumerate(person.get("phones") or []):
        if not phone.get("type") or not PHONE_RE.match(str(phone.get("number") or "")):
            errors.append((f"phones[{i}]", "Телефон: тип і номер у форматі +380XXXXXXXXX"))

    methods = person.get("authentication_methods") or []
    if for_update:
        pass
    elif len(methods) != 1 or methods[0].get("type") != "OTP" or not PHONE_RE.match(str(methods[0].get("phone_number") or "")):
        errors.append(("authentication_methods", "Метод автентифікації: мобільний номер у форматі +380XXXXXXXXX"))

    way = str(person.get("preferred_way_communication") or "").lower()
    if way not in ("email", "phone"):
        errors.append(("preferred_way_communication", "Оберіть бажаний спосіб зв'язку"))
    elif way == "email" and not email:
        errors.append(("email", "Для зв'язку електронною поштою вкажіть її адресу"))

    contact = person.get("emergency_contact") or {}
    if not str(contact.get("first_name") or "").strip() or not str(contact.get("last_name") or "").strip():
        errors.append(("emergency_contact", "Контакт для екстреного зв'язку: ім'я та прізвище обов'язкові"))
    contact_phones = contact.get("phones") or []
    if not contact_phones or any(not p.get("type") or not PHONE_RE.match(str(p.get("number") or ""))
                                 for p in contact_phones):
        errors.append(("emergency_contact.phones", "Контакт для екстреного зв'язку: телефон +380XXXXXXXXX"))
    return errors


def validate_person_update(person, current, today=None):
    """
    п.3.10.1.1: КПІС не дає змінювати РНОКПП і УНЗР, якщо вони вже заповнені в ЕСОЗ.
    current — поточні дані персони з "PIS. Get Person details".
    """
    errors = validate_person_request(person, today, for_update=True)
    if not isinstance(person, dict):
        return errors
    current = current or {}
    if current.get("tax_id") and (person.get("tax_id") != current["tax_id"] or person.get("no_tax_id")):
        errors.append(("tax_id", "РНОКПП, внесений раніше, змінити неможливо"))
    if current.get("unzr") and person.get("unzr") != current["unzr"]:
        errors.append(("unzr", "УНЗР, внесений раніше, змінити неможливо"))
    return errors


# Поля запиту на зміну, які підписує пацієнт (приклад signed_content у специфікації "Complete Update Person
# details"): службові inserted_at / updated_at та інші поля відповіді в підпис не входять
PERSON_REQUEST_SIGNED_FIELDS = ("status", "id", "person", "patient_signed", "process_disclosure_data_consent",
                                "content", "channel")


def person_request_sign_content(request_data):
    """
    Контент для підпису "PIS. Complete Update Person details": дані запиту на зміну
    (відповідь Initialize / Get Person Request Details) з patient_signed = true.
    """
    data = dict(request_data or {})
    data["patient_signed"] = True
    signed = {k: data[k] for k in PERSON_REQUEST_SIGNED_FIELDS if k in data}
    return json.dumps(signed, ensure_ascii=False, separators=(",", ":"))


def clean_person(person):
    """Прибирає порожні необов'язкові значення, щоб не передавати "" у Систему."""
    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if v not in ("", None, [], {})}
        if isinstance(value, list):
            return [clean(v) for v in value if v not in ("", None, [], {})]
        return value.strip() if isinstance(value, str) else value
    result = clean(person)
    result["no_tax_id"] = bool(person.get("no_tax_id"))
    # Специфікація PIS API: preferred_way_communication — email | phone (довідник ЕСОЗ має коди EMAIL/PHONE)
    if result.get("preferred_way_communication"):
        result["preferred_way_communication"] = str(result["preferred_way_communication"]).lower()
    return result


def sign_up_content(person, nonce):
    """Рядок JSON, який пацієнт підписує ЕП для "PIS. Patient sign-up"."""
    return json.dumps({
        "person": person,
        "patient_signed": True,
        "process_disclosure_data_consent": True,
        "jwt": nonce,
    }, ensure_ascii=False, separators=(",", ":"))
