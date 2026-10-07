"""
Локальний стенд кабінету «Плексі» без доступу до ЕСОЗ і бази даних — лише для розробки й тестування.

    python pis/tools/sandbox/run.py            # http://localhost:8765
    python pis/tools/sandbox/run.py --port 9000

Що підміняється (код кабінету не змінюється):
  * ЦБД ЕСОЗ — tools/sandbox/fake_ehealth.py (відповіді за структурами pis/docs/ehealth-pis-api.apib);
  * сервіс авторизації ЕСОЗ (сторінки /sign-in, /sign-up) і redirect-ehealth.js — сторінки стенду /__eh/*;
  * PostgreSQL кабінету (pis_service) — сховище в пам'яті;
  * бібліотека підпису ІІТ (/kep.js) — tools/sandbox/fake_kep.js: будь-який файл ключа, пароль «test».

Панель стенду: http://localhost:8765/__sandbox — персони, імітація збоїв ЕСОЗ (WAF, 401, 500, тайм-аут), журнал викликів.
Мобільний застосунок: у app.json extra.pisApiBase = "http://<IP комп'ютера>:8765" (лише для dev-збірки).
"""

import argparse
import base64
import hashlib
import html
import json
import os
import secrets
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

HERE = os.path.dirname(os.path.abspath(__file__))
PIS = os.path.dirname(os.path.dirname(HERE))
BACKEND = os.path.join(PIS, "backend")


def configure_env(port, host_name):
    base = f"http://{host_name}:{port}"
    tmp = tempfile.mkdtemp(prefix="pis-sandbox-")
    os.environ.update({
        "PIS_ENV_FILE": os.path.join(tmp, "no.env"),       # .env розгортання не читаємо
        "PIS_CRED_FILE": os.path.join(tmp, "no-cred.txt"),
        "PIS_CLIENT_ID": "sandbox-client",
        "PIS_CLIENT_SECRET": "sandbox-api-key",
        "PIS_TOKEN_KEY": base64.urlsafe_b64encode(os.urandom(32)).decode(),
        "PIS_REDIRECT_URI": base + "/__eh/redirect",
        "PIS_API_HOST": base + "/__eh/api",
        "PIS_AUTH_HOST": base + "/__eh/auth",
        "PIS_LOGIN_HOST": base + "/__eh/login",
        "PIS_REGISTRY_DB": os.path.join(tmp, "registry.sqlite3"),
        "PIS_REGISTRY_REFRESH": "0",
        "PIS_TRUST_PROXY": "0",
        "PIS_CORS_ORIGINS": base,
        "PIS_MY_URL": base + "/",
        "PIS_NAME": "Плексі",
        "PIS_SUPPORT_CONTACTS": "support@simplex-med.com",
    })
    return base


class MemoryDb:
    """Заміна pis_service: облікові записи і сесії кабінету в пам'яті (та сама поведінка, що й з PostgreSQL)."""

    def __init__(self, idle_minutes=30):
        self.users, self.sessions, self.lock = {}, {}, threading.Lock()
        self.idle = timedelta(minutes=idle_minutes)

    @staticmethod
    def _hash(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def _new_session(self, user_id, platform="WEB", ip="", ua=""):
        token = secrets.token_urlsafe(32)
        sid = "sess-" + secrets.token_hex(6)
        now = datetime.now(timezone.utc)
        self.sessions[self._hash(token)] = {"session_id": sid, "user_id": user_id, "platform": platform,
                                            "expires_at": now + timedelta(days=30), "last": now,
                                            "access": None, "refresh": None, "eh_expires": None, "person": None}
        return token, sid

    def get_session(self, token):
        if not token:
            return None
        with self.lock:
            s = self.sessions.get(self._hash(token))
            now = datetime.now(timezone.utc)
            if not s or s["expires_at"] < now or (s["platform"] == "WEB" and now - s["last"] > self.idle):
                return None
            s["last"] = now
            u = self.users[s["user_id"]]
            return {"session_id": s["session_id"], "ehealth_access_token": s["access"], "ehealth_refresh_token": s["refresh"],
                    "ehealth_expires_at": s["eh_expires"], "session_person_id": s["person"], "id": u["id"],
                    "phone": u.get("phone"), "email": u.get("email"), "tax_id": u.get("tax_id"), "unzr": u.get("unzr"),
                    "auth_provider": u.get("auth_provider"), "is_verified": u.get("is_verified"),
                    "ehealth_person_id": u.get("ehealth_person_id"), "first_name": u.get("first_name"),
                    "last_name": u.get("last_name"), "second_name": u.get("second_name"),
                    "birth_date": u.get("birth_date"), "gender": u.get("gender")}

    def _by_sid(self, sid):
        return next(s for s in self.sessions.values() if s["session_id"] == sid)

    def set_tokens(self, sid, access, refresh, expires_at, person_id=None):
        with self.lock:
            s = self._by_sid(sid)
            s.update(access=access, refresh=refresh, eh_expires=datetime.fromtimestamp(int(expires_at), timezone.utc))
            if person_id:
                s["person"] = person_id

    def clear_tokens(self, sid):
        with self.lock:
            self._by_sid(sid).update(access=None, refresh=None, eh_expires=None, person=None)

    def create_session(self, user_id, platform="WEB", ip="", ua=""):
        with self.lock:
            return self._new_session(user_id, platform, ip, ua)

    def delete_session(self, token):
        with self.lock:
            self.sessions.pop(self._hash(token or ""), None)

    def link(self, person, current_user_id=None):
        pid = person.get("id")
        if not pid:
            raise ValueError("Профіль ЕСОЗ не містить id персони")
        with self.lock:
            user = next((u for u in self.users.values() if u.get("ehealth_person_id") == pid), None)
            if current_user_id:
                cur = self.users.get(current_user_id) or {}
                if cur.get("ehealth_person_id") and cur["ehealth_person_id"] != pid:
                    return current_user_id, True
                user = user or cur
            if not user:
                user = {"id": "user-" + secrets.token_hex(6), "auth_provider": "EHEALTH"}
                self.users[user["id"]] = user
            user.update(ehealth_person_id=pid, is_verified=True, tax_id=person.get("tax_id"), unzr=person.get("unzr"),
                        first_name=person.get("first_name"), last_name=person.get("last_name"),
                        second_name=person.get("second_name"), birth_date=person.get("birth_date"),
                        gender=person.get("gender"))
            return user["id"], False

    def register(self, first_name, last_name, second_name, phone, email, password, tax_id=None):
        import pis_service
        phone = pis_service.normalize_phone(phone)
        with self.lock:
            if any(u.get("phone") == phone for u in self.users.values()):
                return {"error": "Користувач із таким номером телефону вже зареєстрований"}, 409
            user = {"id": "user-" + secrets.token_hex(6), "phone": phone, "email": email, "tax_id": tax_id,
                    "password": pis_service.hash_password(password), "auth_provider": "LOCAL",
                    "first_name": first_name, "last_name": last_name, "second_name": second_name}
            self.users[user["id"]] = user
            token, _ = self._new_session(user["id"])
        return {"message": "Реєстрація успішна", "token": token, "user": {"id": user["id"], "first_name": first_name,
                                                                          "last_name": last_name, "ehealth_connected": False}}, 201

    def login(self, identifier, password, ip="", ua=""):
        import pis_service
        ident = identifier.strip()
        phone = ident if "@" in ident else pis_service.normalize_phone(ident)
        with self.lock:
            user = next((u for u in self.users.values() if u.get("password") and
                         (u.get("email") == ident.lower() or u.get("phone") == phone)), None)
            if not user or not pis_service.verify_password(password, user["password"]):
                return {"error": "Невірний логін або пароль"}, 401
            token, _ = self._new_session(user["id"], "WEB", ip, ua)
        return {"message": "Авторизація успішна", "token": token,
                "user": {"id": user["id"], "first_name": user["first_name"], "ehealth_connected": False}}, 200


def page(title, body):
    return ("<!doctype html><html lang='uk'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,"
            "initial-scale=1'><title>" + html.escape(title) + "</title><style>"
            "body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#0f172a}"
            "h1{font-size:20px}.banner{background:#fff7ed;border:1px solid #fdba74;color:#7c2d12;padding:10px 12px;"
            "border-radius:10px;font-size:14px;margin-bottom:16px}button,.btn{display:block;width:100%;text-align:left;"
            "padding:12px 14px;margin:8px 0;border-radius:10px;border:1px solid #cbd5e1;background:#fff;font-size:15px;"
            "cursor:pointer}button.primary{background:#273fcc;color:#fff;border-color:#273fcc}"
            "button.danger{border-color:#fca5a5;color:#7f1d1d}code,pre{background:#f1f5f9;padding:2px 4px;border-radius:4px;"
            "font-size:12px;white-space:pre-wrap;word-break:break-all}table{border-collapse:collapse;width:100%;font-size:13px}"
            "td,th{border-bottom:1px solid #e2e8f0;padding:4px 6px;text-align:left}</style></head><body>"
            "<div class='banner'>Тестовий стенд. Це НЕ сервіс ЕСОЗ — дані вигадані.</div>" + body + "</body></html>")


def build(port, host_name="localhost"):
    base = configure_env(port, host_name)
    sys.path.insert(0, BACKEND)
    sys.path.insert(0, HERE)
    import app as A                      # noqa: E402
    import pis_service as ps             # noqa: E402
    from fake_ehealth import PERSONAS, FakeEhealth, unsign  # noqa: E402
    from flask import Response, jsonify, redirect, request  # noqa: E402

    db = MemoryDb()
    ps.get_session = db.get_session
    ps.set_session_ehealth_tokens = db.set_tokens
    ps.clear_session_ehealth_tokens = db.clear_tokens
    ps.create_session = db.create_session
    ps.delete_session = db.delete_session
    ps.link_ehealth_person = db.link
    ps.register_local_patient = db.register
    ps.login_local_patient = db.login

    fake = FakeEhealth(storage_base=base + "/__eh/api")
    A.ehealth.transport = fake
    print("Registry:", A.registry.refresh_due(A.ehealth, force=True))

    app = A.app
    # Cookie з Secure працюють на http://localhost у Chromium; для інших хостів стенду вимикаємо Secure
    if host_name != "localhost":
        orig_set_cookie = Response.set_cookie

        def set_cookie(self, *args, **kwargs):
            kwargs["secure"] = False
            return orig_set_cookie(self, *args, **kwargs)
        Response.set_cookie = set_cookie

    @app.route("/kep.js")
    def sandbox_kep():
        with open(os.path.join(HERE, "fake_kep.js"), encoding="utf-8") as f:
            return Response(f.read(), mimetype="application/javascript")

    # ---------- сервіс авторизації ЕСОЗ (імітація) ----------
    def login_page(mode):
        a = request.args
        state = a.get("state", "")
        redirect_uri = a.get("redirect_uri", "")
        signed = unsign(a.get("user_data") or "") if a.get("user_data") else None
        info = ""
        if a.get("user_data"):
            info = ("<p>Отримано підписані дані (<code>user_data</code>): "
                    + ("підпис стенду коректний." if signed is not None else "<b>підпис не розпізнано</b>.") + "</p>")
        if mode == "sign-up":
            try:
                content = json.loads(signed or "{}")
                person = content.get("person") or {}
            except ValueError:
                person = {}
            name = " ".join(filter(None, [person.get("last_name"), person.get("first_name"), person.get("second_name")]))
            body = (f"<h1>Реєстрація пацієнта в ЕСОЗ (стенд)</h1>{info}<p>Пацієнт: <b>{html.escape(name or '—')}</b></p>"
                    "<form method='post'><input type='hidden' name='mode' value='sign-up'>"
                    f"<input type='hidden' name='state' value='{html.escape(state, quote=True)}'>"
                    f"<input type='hidden' name='redirect_uri' value='{html.escape(redirect_uri, quote=True)}'>"
                    f"<input type='hidden' name='user_data' value='{html.escape(a.get('user_data') or '', quote=True)}'>"
                    "<button class='primary' name='action' value='register'>Підтвердити реєстрацію і надати доступ</button>"
                    "<button name='action' value='deny'>Скасувати</button>"
                    "<button class='danger' name='action' value='err:Person with tax id or document number already exists.'>"
                    "Помилка: пацієнт уже існує</button></form>")
            return page("Реєстрація ЕСОЗ (стенд)", body)
        choices = "".join(
            f"<button name='persona' value='{k}'>{html.escape(p['title'])}</button>" for k, p in PERSONAS.items())
        body = (f"<h1>Вхід до ЕСОЗ (стенд)</h1>{info}<p>Оберіть тестового пацієнта і надайте доступ кабінету "
                f"<b>{html.escape(a.get('client_id', ''))}</b>.</p><form method='post'>"
                f"<input type='hidden' name='state' value='{html.escape(state, quote=True)}'>"
                f"<input type='hidden' name='redirect_uri' value='{html.escape(redirect_uri, quote=True)}'>"
                f"<input type='hidden' name='scope' value='{html.escape(a.get('scope', ''), quote=True)}'>{choices}"
                "<button name='action' value='deny'>Відмовити в доступі (access_denied)</button>"
                "<button class='danger' name='action' value='err:Person not found.'>Помилка: пацієнта не знайдено</button>"
                "<button class='danger' name='action' value='err:Incorrect person age for such an action.'>"
                "Помилка: вік до 14 років</button>"
                "<button class='danger' name='action' value='err:User is blocked.'>Помилка: користувача заблоковано</button>"
                "</form>")
        return page("Вхід ЕСОЗ (стенд)", body)

    def login_submit():
        f = request.form
        redirect_uri, state = f.get("redirect_uri", ""), f.get("state", "")
        action, persona = f.get("action", ""), f.get("persona")
        params = {}
        if action == "deny":
            params = {"error": "access_denied", "error_description": "User denied"}
        elif action.startswith("err:"):
            params = {"error": "invalid_request", "error_description": action[4:]}
        elif f.get("mode") == "sign-up":
            content = json.loads(unsign(f.get("user_data") or "") or "{}")
            persona = fake.create_persona_from_signup(content.get("person") or {})
            params = {"code": fake.issue_code(persona, A.ehealth.config.scope_string)}
        elif persona in fake.people:
            params = {"code": fake.issue_code(persona, f.get("scope", ""))}
        else:
            params = {"error": "invalid_request", "error_description": "server_error"}
        if state:
            params["state"] = state
        return redirect(redirect_uri + ("&" if "?" in redirect_uri else "?") + urlencode(params), 302)

    @app.route("/__eh/login/sign-in", methods=["GET", "POST"])
    def eh_sign_in():
        return login_submit() if request.method == "POST" else login_page("sign-in")

    @app.route("/__eh/login/sign-up", methods=["GET", "POST"])
    def eh_sign_up():
        return login_submit() if request.method == "POST" else login_page("sign-up")

    @app.route("/__eh/redirect")
    def eh_redirect():
        """Аналог redirect-ehealth.js: state "<env>|<шлях>|<nonce>" -> той самий хост стенду + шлях."""
        state = request.args.get("state", "")
        parts = state.split("|")
        path = parts[1] if len(parts) > 1 and parts[1].startswith("/") and not parts[1].startswith("//") else "/"
        query = {k: request.args[k] for k in ("code", "error", "error_description", "state") if k in request.args}
        return redirect(path + "?" + urlencode(query), 302)

    @app.route("/__eh/api/__storage/<path:rest>", methods=["PUT"])
    def eh_storage(rest):
        return "", 200

    # ---------- панель стенду ----------
    @app.route("/__sandbox", methods=["GET"])
    def sandbox_panel():
        rows = "".join(f"<tr><td>{c['t']}</td><td>{c['method']}</td><td>{html.escape(c['path'])}</td><td>{c['status']}</td></tr>"
                       for c in reversed(fake.calls[-60:]))
        faults = html.escape(json.dumps(fake.faults, ensure_ascii=False, indent=1))
        presets = [
            ("waf", "Наступний виклик ЕСОЗ: сторінка WAF «Request Rejected» (HTML, 200)"),
            ("401", "Наступний виклик /api/pis/*: 401 Invalid access token (перевірка оновлення токена)"),
            ("500", "3 виклики /api/pis/*: 500 server_error"),
            ("network", "Наступний виклик: мережевий збій"),
            ("slow", "Наступний виклик /api/pis/person: затримка 8 с"),
            ("unverified", "Підпис запиту на декларацію: 409 Person is not verified"),
            ("clear", "Скасувати всі збої"),
            ("reset", "Скинути дані всіх пацієнтів"),
            ("ttl", "Строк дії токенів ЕСОЗ 130 с (перевірка оновлення за refresh_token)"),
        ]
        buttons = "".join(f"<button name='preset' value='{k}'>{html.escape(t)}</button>" for k, t in presets)
        body = (f"<h1>Панель стенду</h1><p><a href='/'>Відкрити кабінет</a></p><form method='post'>{buttons}</form>"
                f"<h2>Активні збої</h2><pre>{faults}</pre><h2>Виклики ЕСОЗ</h2><table><tr><th>Час</th><th>Метод</th>"
                f"<th>Шлях</th><th>Статус</th></tr>{rows}</table>")
        return page("Панель стенду", body)

    WAF_HTML = ("<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult "
                "with your administrator.<br><br>Your support ID is: 2159518760910355567<br><br>"
                "<a href='javascript:history.back();'>[Go Back]</a></body></html>")

    @app.route("/__sandbox", methods=["POST"])
    def sandbox_action():
        preset = request.form.get("preset") or (request.get_json(silent=True) or {}).get("preset")
        custom = (request.get_json(silent=True) or {}).get("fault")
        with fake.lock:
            if custom:
                fake.faults.append(custom)
            elif preset == "waf":
                fake.faults.append({"path": ".*", "status": 200, "raw": WAF_HTML, "times": 1})
            elif preset == "401":
                fake.faults.append({"path": "^/api/pis/", "status": 401, "message": "Invalid access token",
                                    "type": "access_denied", "times": 1})
            elif preset == "500":
                fake.faults.append({"path": "^/api/pis/", "status": 500, "message": "server_error", "type": "internal_error",
                                    "times": 3})
            elif preset == "network":
                fake.faults.append({"path": ".*", "network": True, "times": 1})
            elif preset == "slow":
                fake.faults.append({"path": "^/api/pis/person$", "delay": 8, "times": 1})
            elif preset == "unverified":
                fake.faults.append({"path": "/actions/sign$", "status": 409, "message": "Person is not verified",
                                    "type": "request_conflict", "times": 1})
            elif preset == "clear":
                fake.faults.clear()
            elif preset == "reset":
                for key in list(fake.people):
                    if key in PERSONAS:
                        fake.reset_persona(key)
            elif preset == "ttl":
                fake.token_ttl = 130
        if request.is_json:
            return jsonify({"faults": fake.faults})
        return redirect("/__sandbox", 303)

    @app.route("/__sandbox/state", methods=["GET"])
    def sandbox_state():
        return jsonify({"calls": fake.calls[-100:], "faults": fake.faults,
                        "people": {k: {"declarations": [{"status": d["status"], "id": d["id"]} for d in v["declarations"]],
                                       "declaration_requests": [{"status": r["status"], "id": r["id"]}
                                                                for r in v["declaration_requests"]],
                                       "person_requests": [{"status": r["status"], "id": r["id"]} for r in v["person_requests"]],
                                       "pending_documents": v["pending_documents"], "apps": len(v["apps"]),
                                       "auth_methods": [(a["type"], a["is_active"]) for a in v["auth_methods"]]}
                                   for k, v in fake.people.items()}})

    return app, fake, db


def main():
    parser = argparse.ArgumentParser(description="Локальний стенд кабінету ПІС")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1", help="інтерфейс (0.0.0.0 — для телефону в тій самій мережі)")
    parser.add_argument("--public-name", default="localhost", help="ім'я хоста в посиланнях (IP для телефону)")
    args = parser.parse_args()
    app, _fake, _db = build(args.port, args.public_name)
    print(f"Кабінет: http://{args.public_name}:{args.port}/   Панель стенду: http://{args.public_name}:{args.port}/__sandbox")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
