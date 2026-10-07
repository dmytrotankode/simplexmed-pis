"""
Локальний кеш реєстрів і довідників ЕСОЗ (п.3.12 ТВ ПІС).

Переліки (лікарі, працівники, ролі, МНП, СГуСОЗ, медичні послуги, договори з НСЗУ,
ліміти декларацій), довідники та адресні дані оновлюються НЕ ЧАСТІШЕ ніж раз на 4 години
і НЕ РІДШЕ ніж раз на добу. Після першого повного завантаження bulk-методи запитуються
з параметром depth (кількість днів змін).

Сховище — SQLite (стандартна бібліотека), щоб модуль переносився в інший продукт.

    store = RegistryStore("registry.sqlite3")
    store.refresh_due(client)                 # викликати періодично (наприклад, щогодини)
    store.search_doctors(patient_age=35, name="Іван", in_contract=True)
"""

import gzip
import json
import math
import re
import sqlite3
import threading
import time
from datetime import date, datetime, timezone

MIN_REFRESH_SECONDS = 4 * 3600     # не частіше ніж раз на 4 години
MAX_REFRESH_SECONDS = 24 * 3600    # не рідше ніж раз на добу
ADULT_AGE = 18                      # конфігураційний параметр adult_age Системи

# speciality_officio лікаря -> хто може обрати (п.3.11.1.4)
PRIMARY_CARE_SPECIALITIES = {"FAMILY_DOCTOR", "THERAPIST", "PEDIATRICIAN"}

# набір даних -> (метод клієнта, чи підтримує depth)
BULK_DATASETS = {
    "parties": ("bulk_parties", True),
    "employees": ("bulk_employees", True),
    "employee_roles": ("bulk_employee_roles", True),
    "divisions": ("bulk_divisions", True),
    "legal_entities": ("bulk_legal_entities", True),
    "healthcare_services": ("bulk_healthcare_services", True),
    "contract_divisions": ("bulk_contract_divisions", True),
    "declarations_limit": ("bulk_declarations_limit", False),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (dataset TEXT PRIMARY KEY, refreshed_at REAL, full_loaded_at REAL, source_date TEXT);
CREATE TABLE IF NOT EXISTS parties (id TEXT PRIMARY KEY, last_name TEXT, first_name TEXT, second_name TEXT,
    search_name TEXT, gender TEXT, year_of_birth INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, party_id TEXT, legal_entity_id TEXT, division_id TEXT,
    employee_type TEXT, status TEXT, is_active INTEGER, speciality TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS ix_employees_party ON employees(party_id);
CREATE INDEX IF NOT EXISTS ix_employees_division ON employees(division_id);
CREATE TABLE IF NOT EXISTS employee_roles (id TEXT PRIMARY KEY, employee_id TEXT, healthcare_service_id TEXT,
    status TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS ix_roles_employee ON employee_roles(employee_id);
CREATE TABLE IF NOT EXISTS divisions (id TEXT PRIMARY KEY, legal_entity_id TEXT, name TEXT, search_name TEXT,
    status TEXT, is_active INTEGER, address_text TEXT, search_address TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS ix_divisions_le ON divisions(legal_entity_id);
CREATE TABLE IF NOT EXISTS legal_entities (id TEXT PRIMARY KEY, name TEXT, public_name TEXT, search_name TEXT,
    status TEXT, is_active INTEGER, edrpou TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS healthcare_services (id TEXT PRIMARY KEY, legal_entity_id TEXT, division_id TEXT,
    speciality_type TEXT, status TEXT, is_active INTEGER, data TEXT);
CREATE INDEX IF NOT EXISTS ix_hs_division ON healthcare_services(division_id);
CREATE TABLE IF NOT EXISTS contract_divisions (division_id TEXT, contract_id TEXT, contract_status TEXT,
    contract_division_status TEXT, contract_end_date TEXT, data TEXT, PRIMARY KEY (division_id, contract_id));
CREATE TABLE IF NOT EXISTS declarations_limit (party_id TEXT PRIMARY KEY, declarations_limit INTEGER,
    declarations_count INTEGER);
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, fetched_at REAL);
"""


def _norm(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower().replace("’", "'").replace("`", "'")


def _payload_items(payload):
    if isinstance(payload, dict):
        data = payload.get("data")
        return data if isinstance(data, list) else []
    return payload if isinstance(payload, list) else []


# Скорочення типів вулиць (довідник STREET_TYPE); невідомий код не показуємо — лише назву вулиці
STREET_TYPE_SHORT = {
    "STREET": "вул.", "AVENUE": "просп.", "BOULEVARD": "бульв.", "LANE": "пров.", "SQUARE": "пл.",
    "ALLEY": "алея", "BLIND_STREET": "тупик", "DESCENT": "узвіз", "EMBANKMENT": "наб.", "QUAY": "наб.",
    "HIGHWAY": "шосе", "MICRODISTRICT": "мкр.", "PASSAGE": "проїзд", "ROAD": "дорога", "PARK": "парк",
    "ISLAND": "острів", "BLOCK": "квартал", "DISTRICT": "район", "SETTLEMENT": "селище", "LINE": "лінія",
}


def address_text(addresses):
    """Адреса МНП одним рядком (для показу і пошуку), без повторів (м. Київ: область = місто)."""
    for a in addresses or []:
        street_type = a.get("street_type_name") or STREET_TYPE_SHORT.get(str(a.get("street_type") or "").upper(), "")
        parts = [a.get("area"), a.get("region"), a.get("settlement"),
                 " ".join(p for p in (street_type, a.get("street")) if p), a.get("building")]
        seen, out = set(), []
        for part in (str(p).strip() for p in parts if p):
            key = part.lower().replace("м.", "").strip()
            if part and key not in seen:
                seen.add(key)
                out.append(part)
        text = ", ".join(out)
        if text:
            return text
    return ""


def main_speciality(employee, party=None):
    """Основна спеціальність лікаря (speciality_officio = true)."""
    candidates = []
    if isinstance(employee.get("speciality"), dict):
        candidates.append(employee["speciality"])
    candidates += ((employee.get("additional_info") or {}).get("specialities") or [])
    candidates += ((party or {}).get("specialities") or [])
    for spec in candidates:
        if spec.get("speciality_officio"):
            return spec.get("speciality")
    return None


def allowed_specialities(patient_age):
    """п.3.11.1.4: сімейний лікар — усім; терапевт — від 18 років; педіатр — до 18 років."""
    allowed = {"FAMILY_DOCTOR"}
    if patient_age is None:
        return allowed | {"THERAPIST", "PEDIATRICIAN"}
    allowed.add("THERAPIST" if patient_age >= ADULT_AGE else "PEDIATRICIAN")
    return allowed


def age_from_birth_date(birth_date, today=None):
    try:
        b = date.fromisoformat(str(birth_date)[:10])
    except ValueError:
        return None
    today = today or date.today()
    return today.year - b.year - ((today.month, today.day) < (b.month, b.day))


class RegistryStore:
    def __init__(self, path, clock=time.time):
        self.path = path
        self.clock = clock
        self._lock = threading.Lock()
        with self._conn() as db:
            db.executescript(SCHEMA)

    def _conn(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        return db

    # ------------------------------------------------------------------
    # Оновлення переліків (п.3.12.2)
    # ------------------------------------------------------------------

    def status(self):
        with self._conn() as db:
            return {r["dataset"]: dict(r) for r in db.execute("SELECT * FROM meta")}

    def is_due(self, dataset, force=False):
        meta = self.status().get(dataset)
        if not meta or not meta.get("refreshed_at"):
            return True
        age = self.clock() - meta["refreshed_at"]
        if age < MIN_REFRESH_SECONDS:
            return False          # не частіше ніж раз на 4 години, навіть примусово
        return force or age >= MIN_REFRESH_SECONDS

    def refresh_due(self, client, datasets=None, force=False):
        """Оновлює набори, для яких минуло ≥ 4 год. Повертає {набір: кількість записів | помилка}."""
        result = {}
        if not self._lock.acquire(blocking=False):
            return {"skipped": "sync already running"}
        try:
            for name in datasets or BULK_DATASETS:
                if not self.is_due(name, force):
                    continue
                try:
                    result[name] = self._refresh_dataset(client, name)
                except Exception as e:  # один недоступний набір не зупиняє інші
                    result[name] = f"error: {e}"
        finally:
            self._lock.release()
        return result

    def _refresh_dataset(self, client, name):
        method, supports_depth = BULK_DATASETS[name]
        meta = self.status().get(name) or {}
        depth = None
        if supports_depth and meta.get("full_loaded_at"):
            days = (self.clock() - (meta.get("refreshed_at") or 0)) / 86400
            depth = max(1, math.ceil(days) + 1)   # з запасом на день
        fn = getattr(client, method)
        payload = fn(depth) if supports_depth else fn()
        if isinstance(payload, (bytes, bytearray)):
            payload = json.loads(gzip.decompress(payload) if payload[:2] == b"\x1f\x8b" else payload)
        items = _payload_items(payload)
        source_date = ((payload or {}).get("meta") or {}).get("date") if isinstance(payload, dict) else None
        full = depth is None
        with self._conn() as db:
            if full and name in ("contract_divisions", "declarations_limit"):
                db.execute(f"DELETE FROM {name}")
            getattr(self, f"_upsert_{name}")(db, items)
            now = self.clock()
            db.execute(
                "INSERT INTO meta(dataset, refreshed_at, full_loaded_at, source_date) VALUES (?,?,?,?) "
                "ON CONFLICT(dataset) DO UPDATE SET refreshed_at=excluded.refreshed_at, source_date=excluded.source_date, "
                "full_loaded_at=COALESCE(excluded.full_loaded_at, meta.full_loaded_at)",
                (name, now, now if full else None, source_date))
        return len(items)

    def _upsert_parties(self, db, items):
        db.executemany(
            "INSERT OR REPLACE INTO parties VALUES (?,?,?,?,?,?,?,?)",
            [(p["id"], p.get("last_name"), p.get("first_name"), p.get("second_name"),
              _norm(" ".join(filter(None, [p.get("last_name"), p.get("first_name"), p.get("second_name")]))),
              p.get("gender"), int(p["year_of_birth"]) if str(p.get("year_of_birth") or "").isdigit() else None,
              json.dumps(p, ensure_ascii=False)) for p in items if p.get("id")])

    def _upsert_employees(self, db, items):
        db.executemany(
            "INSERT OR REPLACE INTO employees VALUES (?,?,?,?,?,?,?,?,?)",
            [(e["id"], e.get("party_id"), e.get("legal_entity_id"), e.get("division_id"),
              (e.get("employee_type") or "").upper(), (e.get("status") or "").upper(), 1 if e.get("is_active") else 0,
              main_speciality(e), json.dumps(e, ensure_ascii=False)) for e in items if e.get("id")])

    def _upsert_employee_roles(self, db, items):
        db.executemany(
            "INSERT OR REPLACE INTO employee_roles VALUES (?,?,?,?,?)",
            [(r["id"], r.get("employee_id"), r.get("healthcare_service_id"), (r.get("status") or "").upper(),
              json.dumps(r, ensure_ascii=False)) for r in items if r.get("id")])

    def _upsert_divisions(self, db, items):
        rows = []
        for d in items:
            if not d.get("id"):
                continue
            addr = address_text(d.get("addresses"))
            rows.append((d["id"], d.get("legal_entity_id"), d.get("name"), _norm(d.get("name")),
                         (d.get("status") or "").upper(), 1 if d.get("is_active", True) else 0,
                         addr, _norm(addr), json.dumps(d, ensure_ascii=False)))
        db.executemany("INSERT OR REPLACE INTO divisions VALUES (?,?,?,?,?,?,?,?,?)", rows)

    def _upsert_legal_entities(self, db, items):
        db.executemany(
            "INSERT OR REPLACE INTO legal_entities VALUES (?,?,?,?,?,?,?,?)",
            [(le["id"], le.get("name"), le.get("public_name"),
              _norm(" ".join(filter(None, [le.get("name"), le.get("public_name"), le.get("short_name")]))),
              (le.get("status") or "").upper(), 1 if le.get("is_active", True) else 0, le.get("edrpou"),
              json.dumps(le, ensure_ascii=False)) for le in items if le.get("id")])

    def _upsert_healthcare_services(self, db, items):
        db.executemany(
            "INSERT OR REPLACE INTO healthcare_services VALUES (?,?,?,?,?,?,?)",
            [(h["id"], h.get("legal_entity_id"), h.get("division_id"), h.get("speciality_type"),
              (h.get("status") or "").upper(), 1 if h.get("is_active", True) else 0,
              json.dumps(h, ensure_ascii=False)) for h in items if h.get("id")])

    def _upsert_contract_divisions(self, db, items):
        db.executemany(
            "INSERT OR REPLACE INTO contract_divisions VALUES (?,?,?,?,?,?)",
            [(c["division_id"], c.get("contract_id"), (c.get("contract_status") or "").lower(),
              (c.get("contract_division_status") or "").lower(), c.get("contract_end_date"),
              json.dumps(c, ensure_ascii=False)) for c in items if c.get("division_id")])

    def _upsert_declarations_limit(self, db, items):
        db.executemany(
            "INSERT OR REPLACE INTO declarations_limit VALUES (?,?,?)",
            [(d["party_id"], d.get("declarations_limit"), d.get("declarations_count"))
             for d in items if d.get("party_id")])

    # ------------------------------------------------------------------
    # Довідники та адреси (п.3.12.1, 3.12.3): кеш відповідей 4–24 год
    # ------------------------------------------------------------------

    def cached(self, key, fetch):
        """Повертає збережену відповідь, якщо їй менше 4 год; інакше запитує заново (не рідше раз на добу)."""
        now = self.clock()
        with self._conn() as db:
            row = db.execute("SELECT data, fetched_at FROM cache WHERE key = ?", (key,)).fetchone()
        if row and now - row["fetched_at"] < MIN_REFRESH_SECONDS:
            return json.loads(row["data"])
        try:
            data = fetch()
        except Exception:
            if row and now - row["fetched_at"] < MAX_REFRESH_SECONDS * 2:
                return json.loads(row["data"])   # тимчасова недоступність ЕСОЗ — віддаємо збережене
            raise
        with self._conn() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?)", (key, json.dumps(data, ensure_ascii=False), now))
        return data

    # ------------------------------------------------------------------
    # Пошук для подання декларації (п.3.11.1.2–3.11.1.5)
    # ------------------------------------------------------------------

    _DOCTOR_SQL = """
    SELECT e.id AS employee_id, e.speciality, p.id AS party_id, p.last_name, p.first_name, p.second_name,
           p.gender, p.year_of_birth, d.id AS division_id, d.name AS division_name, d.address_text,
           le.id AS legal_entity_id, le.name AS legal_entity_name, le.public_name,
           dl.declarations_limit, dl.declarations_count,
           EXISTS (SELECT 1 FROM contract_divisions c WHERE c.division_id = d.id
                   AND c.contract_status = 'active' AND c.contract_division_status = 'active'
                   AND (c.contract_end_date IS NULL OR c.contract_end_date >= :today)) AS in_contract
    FROM employees e
    JOIN parties p ON p.id = e.party_id
    JOIN divisions d ON d.id IN (
        SELECT e.division_id UNION
        SELECT hs.division_id FROM employee_roles r JOIN healthcare_services hs ON hs.id = r.healthcare_service_id
        WHERE r.employee_id = e.id AND r.status = 'ACTIVE' AND hs.status = 'ACTIVE')
    JOIN legal_entities le ON le.id = d.legal_entity_id
    LEFT JOIN declarations_limit dl ON dl.party_id = p.id
    WHERE e.employee_type = 'DOCTOR' AND e.is_active = 1 AND e.status = 'APPROVED'
      AND d.is_active = 1 AND d.status = 'ACTIVE' AND le.is_active = 1 AND le.status = 'ACTIVE'
    """

    def search_doctors(self, patient_age=None, name=None, speciality=None, gender=None, overlimit=None,
                       legal_entity=None, legal_entity_id=None, division=None, division_id=None, address=None,
                       in_contract=None, limit=50, offset=0, today=None):
        """Фільтри п.3.11.1.2; лише лікарі з основною спеціальністю за віком пацієнта (п.3.11.1.4)."""
        allowed = allowed_specialities(patient_age)
        if speciality:
            allowed &= {speciality}
        sql = self._DOCTOR_SQL
        params = {"today": (today or date.today()).isoformat()}
        sql += " AND e.speciality IN (%s)" % ",".join(f":s{i}" for i in range(len(allowed)))
        params.update({f"s{i}": s for i, s in enumerate(sorted(allowed))})
        for i, word in enumerate(_norm(name).split()):
            sql += f" AND p.search_name LIKE :n{i}"
            params[f"n{i}"] = f"%{word}%"
        if gender:
            sql += " AND p.gender = :gender"
            params["gender"] = gender
        if legal_entity_id:
            sql += " AND le.id = :le_id"
            params["le_id"] = legal_entity_id
        if legal_entity:
            sql += " AND le.search_name LIKE :le"
            params["le"] = f"%{_norm(legal_entity)}%"
        if division_id:
            sql += " AND d.id = :div_id"
            params["div_id"] = division_id
        if division:
            sql += " AND d.search_name LIKE :div"
            params["div"] = f"%{_norm(division)}%"
        for i, word in enumerate(_norm(address).split()):
            sql += f" AND d.search_address LIKE :a{i}"
            params[f"a{i}"] = f"%{word}%"
        outer = []
        if overlimit is not None:
            outer.append("(declarations_limit IS NOT NULL AND declarations_limit - declarations_count <= 0) = :over")
            params["over"] = 1 if overlimit else 0
        if in_contract is not None:
            outer.append("in_contract = :contract")
            params["contract"] = 1 if in_contract else 0
        sql = f"SELECT * FROM ({sql})" + (" WHERE " + " AND ".join(outer) if outer else "")
        sql += " ORDER BY last_name, first_name LIMIT :limit OFFSET :offset"
        params.update(limit=min(int(limit), 200), offset=int(offset))
        current_year = (today or date.today()).year
        with self._conn() as db:
            rows = [dict(r) for r in db.execute(sql, params)]
        for r in rows:
            r["in_contract"] = bool(r["in_contract"])
            r["age"] = current_year - r["year_of_birth"] if r.get("year_of_birth") else None
            if r.get("declarations_limit") is not None:
                r["declarations_available"] = r["declarations_limit"] - (r["declarations_count"] or 0)
                r["overlimit"] = r["declarations_available"] <= 0
            else:
                r["declarations_available"] = None
                r["overlimit"] = False
        return rows

    def search_legal_entities(self, name=None, limit=50):
        sql = "SELECT id, name, public_name, edrpou FROM legal_entities WHERE is_active = 1 AND status = 'ACTIVE'"
        params = {}
        for i, word in enumerate(_norm(name).split()):
            sql += f" AND search_name LIKE :n{i}"
            params[f"n{i}"] = f"%{word}%"
        with self._conn() as db:
            return [dict(r) for r in db.execute(sql + " ORDER BY name LIMIT :limit", {**params, "limit": limit})]

    def search_divisions(self, legal_entity_id=None, name=None, address=None, limit=100, today=None):
        """п.3.11.1.3.1: МНП обраного СГуСОЗ (та пошук за назвою/адресою)."""
        sql = """SELECT d.id, d.name, d.address_text, d.legal_entity_id, le.name AS legal_entity_name,
                 EXISTS (SELECT 1 FROM contract_divisions c WHERE c.division_id = d.id AND c.contract_status = 'active'
                         AND c.contract_division_status = 'active'
                         AND (c.contract_end_date IS NULL OR c.contract_end_date >= :today)) AS in_contract
                 FROM divisions d JOIN legal_entities le ON le.id = d.legal_entity_id
                 WHERE d.is_active = 1 AND d.status = 'ACTIVE'"""
        params = {"today": (today or date.today()).isoformat()}
        if legal_entity_id:
            sql += " AND d.legal_entity_id = :le"
            params["le"] = legal_entity_id
        for i, word in enumerate(_norm(name).split()):
            sql += f" AND d.search_name LIKE :n{i}"
            params[f"n{i}"] = f"%{word}%"
        for i, word in enumerate(_norm(address).split()):
            sql += f" AND d.search_address LIKE :a{i}"
            params[f"a{i}"] = f"%{word}%"
        with self._conn() as db:
            rows = [dict(r) for r in db.execute(sql + " ORDER BY d.name LIMIT :limit", {**params, "limit": limit})]
        for r in rows:
            r["in_contract"] = bool(r["in_contract"])
        return rows

    def division_in_contract(self, division_id, today=None):
        """Чи входить МНП до чинного договору з НСЗУ (п.3.11.1.7). None — МНП немає в кеші реєстру."""
        with self._conn() as db:
            row = db.execute("""SELECT EXISTS (SELECT 1 FROM contract_divisions c WHERE c.division_id = d.id
                                    AND c.contract_status = 'active' AND c.contract_division_status = 'active'
                                    AND (c.contract_end_date IS NULL OR c.contract_end_date >= :today)) AS in_contract
                                FROM divisions d WHERE d.id = :id""",
                             {"id": division_id, "today": (today or date.today()).isoformat()}).fetchone()
        return bool(row["in_contract"]) if row else None

    def doctor_details(self, employee_id):
        """п.3.11.1.5: дані про лікаря — ПІБ, стать, спеціальності, вік, освіта, кваліфікації та інше."""
        with self._conn() as db:
            row = db.execute("SELECT e.data AS employee, p.data AS party, dl.declarations_limit, dl.declarations_count "
                             "FROM employees e JOIN parties p ON p.id = e.party_id "
                             "LEFT JOIN declarations_limit dl ON dl.party_id = p.id WHERE e.id = ?",
                             (employee_id,)).fetchone()
        if not row:
            return None
        party = json.loads(row["party"])
        employee = json.loads(row["employee"])
        year = int(party["year_of_birth"]) if str(party.get("year_of_birth") or "").isdigit() else None
        info = employee.get("additional_info") or {}
        return {
            "employee_id": employee_id,
            "first_name": party.get("first_name"), "last_name": party.get("last_name"),
            "second_name": party.get("second_name"), "gender": party.get("gender"),
            "age": date.today().year - year if year else None,
            "specialities": party.get("specialities") or info.get("specialities") or [],
            "educations": party.get("educations") or info.get("educations") or [],
            "qualifications": party.get("qualifications") or info.get("qualifications") or [],
            "science_degree": party.get("science_degree") or info.get("science_degree"),
            "working_experience": party.get("working_experience"),
            "about_myself": party.get("about_myself"),
            "declarations_limit": row["declarations_limit"], "declarations_count": row["declarations_count"],
            "party": party, "employee": employee,
        }


def start_background_refresh(store, client, interval_seconds=3600, logger=None):
    """Фоновий потік: щогодини перевіряє, які набори пора оновити (≥4 год, ≤24 год)."""
    def loop():
        while True:
            try:
                result = store.refresh_due(client)
                if result and logger:
                    logger.info(f"Registry refresh: {result}")
            except Exception as e:  # pragma: no cover - логування в робочому середовищі
                if logger:
                    logger.warning(f"Registry refresh failed: {e}")
            time.sleep(interval_seconds)
    thread = threading.Thread(target=loop, name="ehealth-registry-refresh", daemon=True)
    thread.start()
    return thread


def utc_iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None
