"""
SimplexMed 2.0 — PIS Backend Service: шар даних кабінету (PostgreSQL).

- Власні облікові записи SimplexMed (Email / Телефон + Пароль).
- Сесії кабінету. Токени ЕСОЗ прив'язані до сесії (не до облікового запису) і
  зберігаються лише на сервері в зашифрованому вигляді: вхід локальним обліковим
  записом не дає доступу до даних ЕСОЗ без авторизації через сервіс Системи (п.1.5.2).
- Виклики API ЕСОЗ — у пакеті ehealth_pis (без залежностей від БД і Flask).
Вхід через КЕП як окремий спосіб вимкнено — див. login_kep_patient().

Секрети (PG_PASSWORD, PIS_TOKEN_KEY) беруться лише з оточення / .env.
"""

import os
import uuid
import hashlib
import hmac
import binascii
import logging
from datetime import datetime, timezone, timedelta
import psycopg2
from psycopg2.extras import RealDictCursor
from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("pis_service")

SESSION_TTL = timedelta(days=30)
# Веб-сесія завершується після бездіяльності (мобільний застосунок блокується PIN-кодом через 5 хв, п.2.9)
WEB_IDLE_TIMEOUT = timedelta(minutes=int(os.getenv("PIS_WEB_IDLE_MINUTES", "30")))

# ------------------------------------------------------------------------------
# 1. ПІДКЛЮЧЕННЯ ДО БАЗИ ДАНИХ (simplex-pis-dev)
# ------------------------------------------------------------------------------

def get_db():
    host = os.getenv("PG_HOST", "10.0.0.4")
    port = int(os.getenv("PG_PORT", 50431))
    user = os.getenv("PG_USER", "simplex")
    password = os.getenv("PG_PASSWORD")
    if not password:
        raise RuntimeError("PG_PASSWORD не задано в оточенні (див. pis/deploy/.env.example)")
    dbname = os.getenv("DB_PIS_NAME", "simplex-pis-dev")
    return psycopg2.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        dbname=dbname,
        cursor_factory=RealDictCursor
    )

# ------------------------------------------------------------------------------
# 2. БЕЗПЕКА ТА ХЕШУВАННЯ ПАРОЛІВ (PBKDF2-HMAC-SHA256)
# ------------------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = os.urandom(16)
    pwd_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
    return f"pbkdf2:sha256:100000${binascii.hexlify(salt).decode()}${binascii.hexlify(pwd_hash).decode()}"

def verify_password(password: str, hashed: str) -> bool:
    if not hashed or not hashed.startswith("pbkdf2:sha256:"):
        return False
    try:
        parts = hashed.split("$")
        salt = binascii.unhexlify(parts[1])
        expected_hash = binascii.unhexlify(parts[2])
        actual_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
        return hmac.compare_digest(actual_hash, expected_hash)
    except Exception:
        return False

def normalize_phone(phone: str) -> str:
    """Приводить український номер до формату +380XXXXXXXXX."""
    digits = "".join(ch for ch in phone if ch.isdigit())
    if digits.startswith("380") and len(digits) == 12:
        return "+" + digits
    if digits.startswith("80") and len(digits) == 11:
        return "+3" + digits
    if digits.startswith("0") and len(digits) == 10:
        return "+38" + digits
    return "+" + digits

def delete_session(token):
    if not token:
        return
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM pis_core.sessions WHERE refresh_token_hash = %s;", (token_hash,))
        conn.commit()
    finally:
        conn.close()

def _create_session(conn, user_id, platform="WEB", ip="127.0.0.1", ua=""):
    session_token = str(uuid.uuid4()) + "-" + binascii.hexlify(os.urandom(24)).decode()
    token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
    expires_at = datetime.now(timezone.utc) + SESSION_TTL
    device_id = str(uuid.uuid4())

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO pis_core.sessions 
            (user_id, device_id, device_platform, refresh_token_hash, ip_address, user_agent, expires_at, last_activity_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
            RETURNING id;
            """,
            (user_id, device_id, platform, token_hash, ip or None, ua, expires_at)  # ip_address: inet, "" недопустимий
        )
    return session_token, expires_at

# ------------------------------------------------------------------------------
# 3. АВТОРИЗАЦІЯ ЧЕРЕЗ НАШУ ОБЛІКОВКУ (Email / Телефон + Пароль)
# ------------------------------------------------------------------------------

def register_local_patient(first_name, last_name, second_name, phone, email, password, tax_id=None):
    clean_phone = normalize_phone(phone)

    hashed_pw = hash_password(password)

    conn = get_db()
    try:
        with conn.cursor() as cur:
            # Перевірка дублікату за телефоном
            cur.execute("SELECT id FROM pis_core.users WHERE phone = %s;", (clean_phone,))
            if cur.fetchone():
                return {"error": "Користувач із таким номером телефону вже зареєстрований"}, 409

            if email:
                cur.execute("SELECT id FROM pis_core.users WHERE email = %s;", (email.lower().strip(),))
                if cur.fetchone():
                    return {"error": "Користувач із такою електронною поштою вже зареєстрований"}, 409

            # Створення користувача
            user_id = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO pis_core.users 
                (id, phone, email, password_hash, tax_id, auth_provider, is_verified, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, 'LOCAL', FALSE, NOW(), NOW())
                RETURNING id;
                """,
                (user_id, clean_phone, (email.lower().strip() if email else None), hashed_pw, tax_id)
            )

            # Створення додаткових відомостей
            cur.execute(
                """
                INSERT INTO pis_core.patient_details
                (user_id, first_name, last_name, second_name, updated_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    first_name = EXCLUDED.first_name,
                    last_name = EXCLUDED.last_name,
                    second_name = EXCLUDED.second_name,
                    updated_at = NOW();
                """,
                (user_id, first_name, last_name, second_name)
            )

            session_token, expires_at = _create_session(conn, user_id)
            conn.commit()

            return {
                "message": "Реєстрація успішна",
                "token": session_token,
                "expires_at": expires_at.isoformat(),
                "user": {
                    "id": user_id,
                    "first_name": first_name,
                    "last_name": last_name,
                    "second_name": second_name,
                    "phone": clean_phone,
                    "email": email,
                    "tax_id": tax_id,
                    "auth_provider": "LOCAL",
                    "ehealth_connected": False
                }
            }, 201
    except Exception as e:
        conn.rollback()
        logger.error(f"Registration error: {type(e).__name__}")  # текст помилки БД може містити телефон/email
        return {"error": "Помилка реєстрації. Спробуйте пізніше"}, 500
    finally:
        conn.close()

def login_local_patient(identifier, password, ip="127.0.0.1", ua=""):
    ident = identifier.strip()
    phone_ident = ident if "@" in ident else normalize_phone(ident)
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.id, u.phone, u.email, u.password_hash, u.tax_id, u.unzr, u.auth_provider, u.ehealth_person_id,
                       d.first_name, d.last_name, d.second_name, d.birth_date, d.gender
                FROM pis_core.users u
                LEFT JOIN pis_core.patient_details d ON u.id = d.user_id
                WHERE u.email = %s OR u.phone = %s;
                """,
                (ident.lower(), phone_ident)
            )
            row = cur.fetchone()
            if not row:
                return {"error": "Невірний логін або пароль"}, 401

            if not verify_password(password, row["password_hash"]):
                return {"error": "Невірний логін або пароль"}, 401

            session_token, expires_at = _create_session(conn, row["id"], "WEB", ip, ua)
            conn.commit()

            return {
                "message": "Авторизація успішна",
                "token": session_token,
                "expires_at": expires_at.isoformat(),
                "user": {
                    "id": row["id"],
                    "first_name": row["first_name"] or "",
                    "last_name": row["last_name"] or "",
                    "second_name": row["second_name"] or "",
                    "phone": row["phone"],
                    "email": row["email"],
                    "tax_id": row["tax_id"],
                    "unzr": row["unzr"],
                    "auth_provider": row["auth_provider"],
                    "ehealth_person_id": row["ehealth_person_id"],
                    # нова сесія: доступ до ЕСОЗ лише після входу через сервіс авторизації Системи
                    "ehealth_connected": False
                }
            }, 200
    except Exception as e:
        conn.rollback()
        logger.error(f"Login error: {e}")
        return {"error": "Помилка авторизації. Спробуйте пізніше"}, 500
    finally:
        conn.close()

# ------------------------------------------------------------------------------
# 4. АВТОРИЗАЦІЯ ЧЕРЕЗ КЕП (Електронний цифровий підпис / Дія.Підпис)
# ------------------------------------------------------------------------------

def login_kep_patient(key_bytes, filename, password, acsk_id="auto", ip="127.0.0.1", ua=""):
    """
    Вхід за КЕП тимчасово вимкнено.

    Попередня реалізація не перевіряла ланцюжок сертифіката до акредитованого КНЕДП
    і для форматів, відмінних від PKCS#12, приймала будь-який файл та пароль, беручи
    РНОКПП з довільних 10 цифр у файлі — це дозволяло увійти в чужий обліковий запис.
    Повернути можна лише з повноцінною перевіркою підпису (бібліотека ІІТ / Дія.Підпис)
    за схемою "challenge -> підпис -> перевірка сертифіката і РНОКПП на сервері".
    """
    return {"error": "Вхід за КЕП тимчасово недоступний. Скористайтеся входом через eHealth"}, 501


# ------------------------------------------------------------------------------
# 5. СЕСІЇ КАБІНЕТУ ТА ТОКЕНИ ЕСОЗ
# ------------------------------------------------------------------------------

def _fernet():
    key = os.getenv("PIS_TOKEN_KEY")
    if not key:
        raise RuntimeError("PIS_TOKEN_KEY не задано в оточенні (див. pis/deploy/.env.example)")
    return Fernet(key.encode("ascii"))


def encrypt_token(value):
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii") if value else None


def decrypt_token(value):
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except InvalidToken:
        logger.warning("Cannot decrypt stored eHealth token (key changed?)")
        return None


def _token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def get_session(session_token):
    """Сесія кабінету з даними користувача і розшифрованими токенами ЕСОЗ цієї сесії."""
    if not session_token:
        return None
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT s.id AS session_id, s.ehealth_access_token, s.ehealth_refresh_token,
                       s.ehealth_expires_at, s.ehealth_person_id AS session_person_id,
                       u.id, u.phone, u.email, u.tax_id, u.unzr, u.auth_provider, u.is_verified,
                       u.ehealth_person_id,
                       d.first_name, d.last_name, d.second_name, d.birth_date, d.gender
                FROM pis_core.sessions s
                JOIN pis_core.users u ON s.user_id = u.id
                LEFT JOIN pis_core.patient_details d ON u.id = d.user_id
                WHERE s.refresh_token_hash = %s AND s.expires_at > NOW()
                  AND NOT (s.device_platform = 'WEB' AND s.last_activity_at < NOW() - %s);
                """,
                (_token_hash(session_token), WEB_IDLE_TIMEOUT)
            )
            row = cur.fetchone()
            if not row:
                return None
            cur.execute("UPDATE pis_core.sessions SET last_activity_at = NOW() WHERE id = %s;", (row["session_id"],))
        conn.commit()
        session = dict(row)
        session["ehealth_access_token"] = decrypt_token(session["ehealth_access_token"])
        session["ehealth_refresh_token"] = decrypt_token(session["ehealth_refresh_token"])
        return session
    finally:
        conn.close()


def set_session_ehealth_tokens(session_id, access_token, refresh_token, expires_at, person_id=None):
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pis_core.sessions
                SET ehealth_access_token = %s, ehealth_refresh_token = %s,
                    ehealth_expires_at = to_timestamp(%s),
                    ehealth_person_id = COALESCE(%s, ehealth_person_id)
                WHERE id = %s;
                """,
                (encrypt_token(access_token), encrypt_token(refresh_token), int(expires_at), person_id, session_id)
            )
        conn.commit()
    finally:
        conn.close()


def clear_session_ehealth_tokens(session_id):
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pis_core.sessions
                SET ehealth_access_token = NULL, ehealth_refresh_token = NULL,
                    ehealth_expires_at = NULL, ehealth_person_id = NULL
                WHERE id = %s;
                """,
                (session_id,)
            )
        conn.commit()
    finally:
        conn.close()


def create_session(user_id, platform="WEB", ip="127.0.0.1", ua=""):
    """Повертає (session_token, session_id)."""
    conn = get_db()
    try:
        session_token, _ = _create_session(conn, user_id, platform, ip, ua)
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM pis_core.sessions WHERE refresh_token_hash = %s;", (_token_hash(session_token),))
            session_id = cur.fetchone()["id"]
        conn.commit()
        return session_token, session_id
    finally:
        conn.close()


def link_ehealth_person(person, current_user_id=None):
    """
    Знаходить або створює обліковий запис кабінету для персони ЕСОЗ.

    Зв'язуємо лише за ehealth_person_id або з поточним обліковим записом, до якого
    ЕСОЗ ще не прив'язано. Телефон і РНОКПП локальних облікових записів не верифіковані,
    тому зіставлення за ними дозволяло б захопити чужий доступ до ЕСОЗ.
    Повертає (user_id, conflict): conflict=True, якщо поточний обліковий запис уже
    прив'язаний до іншої персони ЕСОЗ.
    """
    eh_person_id = person.get("id")
    if not eh_person_id:
        raise ValueError("Профіль ЕСОЗ не містить id персони")
    phones = person.get("phones") or []
    phone = phones[0].get("number") if phones else None
    tax_id = str(person["tax_id"]).strip()[:10] if person.get("tax_id") else None

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM pis_core.users WHERE ehealth_person_id = %s;", (eh_person_id,))
            row = cur.fetchone()
            user_id = row["id"] if row else None

            if current_user_id:
                cur.execute("SELECT ehealth_person_id FROM pis_core.users WHERE id = %s;", (current_user_id,))
                cur_row = cur.fetchone()
                linked = cur_row["ehealth_person_id"] if cur_row else None
                if linked and str(linked) != str(eh_person_id):
                    return current_user_id, True
                if not user_id:
                    user_id = current_user_id

            if not user_id:
                user_id = str(uuid.uuid4())
                user_phone = phone
                if user_phone:
                    cur.execute("SELECT id FROM pis_core.users WHERE phone = %s;", (user_phone,))
                    if cur.fetchone():
                        user_phone = None
                # phone NOT NULL UNIQUE VARCHAR(20): технічне значення, якщо номер зайнятий чи відсутній
                user_phone = user_phone or f"eh{uuid.uuid4().hex[:18]}"
                cur.execute(
                    """
                    INSERT INTO pis_core.users
                    (id, phone, email, tax_id, unzr, ehealth_person_id, auth_provider, is_verified, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, 'EHEALTH', TRUE, NOW(), NOW());
                    """,
                    (user_id, user_phone, person.get("email"), tax_id, person.get("unzr"), eh_person_id)
                )
            else:
                cur.execute(
                    """
                    UPDATE pis_core.users
                    SET ehealth_person_id = %s, tax_id = COALESCE(%s, tax_id), unzr = COALESCE(%s, unzr),
                        is_verified = TRUE, updated_at = NOW()
                    WHERE id = %s;
                    """,
                    (eh_person_id, tax_id, person.get("unzr"), user_id)
                )

            cur.execute(
                """
                INSERT INTO pis_core.patient_details
                (user_id, first_name, last_name, second_name, birth_date, gender, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    first_name = COALESCE(EXCLUDED.first_name, patient_details.first_name),
                    last_name = COALESCE(EXCLUDED.last_name, patient_details.last_name),
                    second_name = COALESCE(EXCLUDED.second_name, patient_details.second_name),
                    birth_date = COALESCE(EXCLUDED.birth_date, patient_details.birth_date),
                    gender = COALESCE(EXCLUDED.gender, patient_details.gender),
                    updated_at = NOW();
                """,
                (user_id, person.get("first_name"), person.get("last_name"), person.get("second_name"),
                 person.get("birth_date") or None, person.get("gender"))
            )
        conn.commit()
        return user_id, False
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
