"""
Розділ «Тестування» кабінету «Плексі»: інтерактивні інструкції для тестувальників ДП «Електронне здоров'я»
(і внутрішнього QA) за пунктами Технічних вимог до ПІС №978.

Модуль самодостатній і підключається одним викликом ``tester.register(app, deps)``; MFX або інший хост може
вимкнути його, не задаючи PIS_TESTER_MODE. Доступ:

  * режим увімкнено змінною PIS_TESTER_MODE=1 (лише на тестовому середовищі, у проді не задавати);
  * користувач — тестувальник: запис у pis_core.tester_users (з терміном дії), або його РНОКПП у PIS_TESTER_TAX_IDS
    (через кому), або PIS_TESTER_OPEN=1 (будь-який авторизований — лише для внутрішнього стенда);
  * інакше відповідь 404 (існування розділу не розкриваємо).

Дані — backend/tester_data/{tv-tree,scenarios}.json (збираються tools/tester/*.py), прогрес — pis_core.tester_marks.
"""
import json
import os

from flask import jsonify, request

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tester_data")
STATUSES = ("ok", "fail", "skip")
PLATFORMS = ("web", "android", "ios", "huawei")
_cache = {}


def enabled():
    """Режим увімкнено змінною і лише на тестових хостах (прод-домен кабінету розділу не має)."""
    if os.getenv("PIS_TESTER_MODE", "0") != "1":
        return False
    hosts = {h.strip().lower() for h in os.getenv(
        "PIS_TESTER_HOSTS", "my-dev.simplex-med.com,localhost,127.0.0.1").split(",") if h.strip()}
    host = (request.host or "").split(":")[0].lower()
    return host in hosts


def _load(name):
    path = os.path.join(DATA_DIR, name)
    mtime = os.path.getmtime(path)
    hit = _cache.get(name)
    if not hit or hit[0] != mtime:
        with open(path, encoding="utf-8") as f:
            _cache[name] = (mtime, json.load(f))
    return _cache[name][1]


def _tax_ids():
    return {t.strip() for t in os.getenv("PIS_TESTER_TAX_IDS", "").split(",") if t.strip()}


def _db_flag(get_db, user_id):
    """Запис у pis_core.tester_users окремим запитом: основний вхід не залежить від міграції 002."""
    try:
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok FROM pis_core.tester_users WHERE user_id = %s "
                            "AND (valid_until IS NULL OR valid_until > NOW());", (user_id,))
                return cur.fetchone() is not None
        finally:
            conn.close()
    except Exception:
        return False


def is_tester(session, get_db=None):
    if not enabled() or not session:
        return False
    if os.getenv("PIS_TESTER_OPEN", "0") == "1":
        return True
    if session.get("tax_id") and str(session["tax_id"]) in _tax_ids():
        return True
    return bool(get_db and _db_flag(get_db, session["id"]))


def register(app, current_session, get_db, rate_limit=None):
    """current_session() -> dict | None; get_db() -> psycopg2 connection."""
    limiter = rate_limit("tester", 120, 60) if rate_limit else (lambda fn: fn)

    def guard(fn):
        def wrapper(*args, **kwargs):
            session = current_session()
            if not is_tester(session, get_db):
                return jsonify({"error": "Not found"}), 404
            return fn(session, *args, **kwargs)
        wrapper.__name__ = fn.__name__
        return wrapper

    @app.route("/api/tester/content", methods=["GET"])
    @limiter
    @guard
    def tester_content(session):
        return jsonify({"tree": _load("tv-tree.json"), "scenarios": _load("scenarios.json")["scenarios"]}), 200

    @app.route("/api/tester/marks", methods=["GET"])
    @limiter
    @guard
    def tester_marks(session):
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT scenario_id, platform, status, note, updated_at FROM pis_core.tester_marks "
                            "WHERE user_id = %s;", (session["id"],))
                rows = cur.fetchall()
        finally:
            conn.close()
        return jsonify({"data": [
            {"scenario_id": r["scenario_id"], "platform": r["platform"], "status": r["status"], "note": r["note"],
             "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None} for r in rows]}), 200

    @app.route("/api/tester/marks", methods=["PUT"])
    @limiter
    @guard
    def tester_set_mark(session):
        body = request.get_json(silent=True) or {}
        scenario_id = str(body.get("scenario_id") or "")
        platform = str(body.get("platform") or "web")
        status = str(body.get("status") or "")
        note = str(body.get("note") or "")[:2000]
        known = {s["id"] for s in _load("scenarios.json")["scenarios"]}
        if scenario_id not in known or platform not in PLATFORMS or status not in STATUSES:
            return jsonify({"error": "Некоректна відмітка"}), 400
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO pis_core.tester_marks (user_id, scenario_id, platform, status, note, updated_at)
                       VALUES (%s, %s, %s, %s, %s, NOW())
                       ON CONFLICT (user_id, scenario_id, platform)
                       DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = NOW();""",
                    (session["id"], scenario_id, platform, status, note))
            conn.commit()
        finally:
            conn.close()
        return jsonify({"message": "Збережено"}), 200

    @app.route("/api/tester/marks/<scenario_id>", methods=["DELETE"])
    @limiter
    @guard
    def tester_clear_mark(session, scenario_id):
        platform = request.args.get("platform", "web")
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM pis_core.tester_marks WHERE user_id = %s AND scenario_id = %s AND platform = %s;",
                            (session["id"], scenario_id, platform))
            conn.commit()
        finally:
            conn.close()
        return jsonify({"message": "Відмітку знято"}), 200
