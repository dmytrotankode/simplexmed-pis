"""Тести BFF кабінету (Flask) з заглушками БД і ЕСОЗ."""

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)
os.environ.update({"PIS_CLIENT_ID": "CID", "PIS_CLIENT_SECRET": "SECRET", "PIS_NAME": "SimplexMed",
                   "PIS_SUPPORT_CONTACTS": "support@simplex-med.com"})

import app as A  # noqa: E402
import pis_service as ps  # noqa: E402
from ehealth_pis.transport import HttpResponse  # noqa: E402


class FakeEhealth:
    """Відповіді ЕСОЗ за (метод, шлях без query)."""

    def __init__(self):
        self.routes, self.calls = {}, []

    def on(self, method, path, status, body):
        self.routes.setdefault((method, path), []).append((status, body))

    def request(self, method, url, headers=None, body=None, timeout=60):
        path = urllib.parse.urlparse(url).path
        self.calls.append((method, path, headers or {}, body))
        queue = self.routes.get((method, path)) or [(404, {"error": {"type": "not_found", "message": "not stubbed"}})]
        status, payload = queue.pop(0) if len(queue) > 1 else queue[0]
        return HttpResponse(status, json.dumps(payload).encode())


class FakeDb:
    def __init__(self):
        self.sessions, self.deleted, self.users = {}, [], {}

    def add_session(self, token, user_id="U1", eh_person=None, access=None, refresh=None, expires_in=3600):
        self.sessions[token] = {
            "session_id": f"S-{token}", "id": user_id, "ehealth_person_id": eh_person,
            "ehealth_access_token": access, "ehealth_refresh_token": refresh,
            "ehealth_expires_at": datetime.now(timezone.utc) + timedelta(seconds=expires_in) if access else None,
            "first_name": "Тест", "phone": "+380000000000", "auth_provider": "LOCAL"}

    def by_sid(self, sid):
        return next(s for s in self.sessions.values() if s["session_id"] == sid)

    def get_session(self, token):
        s = self.sessions.get(token)
        return dict(s) if s else None

    def set_tokens(self, sid, access, refresh, expires_at, person_id=None):
        s = self.by_sid(sid)
        s.update(ehealth_access_token=access, ehealth_refresh_token=refresh,
                 ehealth_expires_at=datetime.fromtimestamp(expires_at, timezone.utc))
        if person_id:
            s["ehealth_person_id"] = person_id

    def clear_tokens(self, sid):
        self.by_sid(sid).update(ehealth_access_token=None, ehealth_refresh_token=None, ehealth_expires_at=None)

    def create_session(self, user_id, platform="WEB", ip="", ua=""):
        token = f"NEW{len(self.sessions)}"
        self.add_session(token, user_id)
        return token, f"S-{token}"

    def link(self, person, current_user_id=None):
        self.users[person["id"]] = current_user_id or "U-EH"
        return self.users[person["id"]], False


@pytest.fixture
def env(monkeypatch):
    db, eh = FakeDb(), FakeEhealth()
    monkeypatch.setattr(ps, "get_session", db.get_session)
    monkeypatch.setattr(ps, "set_session_ehealth_tokens", db.set_tokens)
    monkeypatch.setattr(ps, "clear_session_ehealth_tokens", db.clear_tokens)
    monkeypatch.setattr(ps, "create_session", db.create_session)
    monkeypatch.setattr(ps, "link_ehealth_person", db.link)
    monkeypatch.setattr(ps, "delete_session", lambda t: db.deleted.append(t))
    monkeypatch.setattr(A.ehealth, "transport", eh)
    A._rate_hits.clear()
    return A.app.test_client(), db, eh


def token_body(value="EH_AT", refresh="EH_RT", expires_in=3600):
    return {"data": {"value": value, "expires_at": int(time.time()) + expires_in, "user": {"person_id": "P1"},
                     "details": {"refresh_token": refresh, "scope": "person:details_pis"}}}


def start_login(c, env_name="my-dev"):
    r = c.get(f"/api/auth-url?env={env_name}")
    q = urllib.parse.parse_qs(urllib.parse.urlparse(r.get_json()["url"]).query)
    return q


def test_auth_url_and_state(env):
    c, _, _ = env
    assert c.get("/api/auth-url?env=evil").status_code == 400
    q = start_login(c)
    state = q["state"][0]
    assert q["redirect_uri"] == ["https://simplex-med.com"]
    assert state.startswith("my-dev|/|") and len(state.split("|")[2]) > 20
    assert c.get_cookie("pis_oauth_state").value == state.split("|")[2]


def test_auth_url_post_with_signed_user_data(env):
    c, _, _ = env
    assert c.post("/api/auth-url", json={"env": "my", "user_data": "not base64!"}).status_code == 400
    r = c.post("/api/auth-url", json={"env": "my", "user_data": "U0lHTkVE"})
    q = urllib.parse.parse_qs(urllib.parse.urlparse(r.get_json()["url"]).query)
    assert q["user_data"] == ["U0lHTkVE"]


def test_exchange_rejects_forged_or_missing_state(env):
    c, _, _ = env
    start_login(c)
    assert c.post("/api/auth/token", json={"code": "C", "state": "my-dev|/|forged"}).status_code == 400
    assert c.post("/api/auth/token", json={"code": "C"}).status_code == 400


def test_exchange_creates_session_and_keeps_tokens_server_side(env):
    c, db, eh = env
    state = start_login(c)["state"][0]
    eh.on("POST", "/oauth/tokens", 201, token_body())
    eh.on("GET", "/api/pis/person", 200, {"data": {"id": "P1", "first_name": "Іван"}})
    r = c.post("/api/auth/token", json={"code": "GOOD", "state": state})
    body = r.get_json()
    assert r.status_code == 200 and body["ehealth_connected"]
    assert "EH_AT" not in r.get_data(as_text=True) and "EH_RT" not in r.get_data(as_text=True)
    cookies = r.headers.getlist("Set-Cookie")
    assert any(h.startswith("pis_session_token=NEW") and "HttpOnly" in h for h in cookies)
    assert not any(h.startswith("pis_access_token") for h in cookies)
    assert any(h.startswith("pis_oauth_state=;") for h in cookies)
    session = db.sessions[c.get_cookie("pis_session_token").value]
    assert session["ehealth_access_token"] == "EH_AT" and session["ehealth_refresh_token"] == "EH_RT"
    # API-key у кожному виклику
    assert all(call[2].get("API-key") == "SECRET" for call in eh.calls)


def test_exchange_in_local_session_attaches_to_it(env):
    c, db, eh = env
    db.add_session("LOCAL1", user_id="U-LOCAL")
    c.set_cookie("pis_session_token", "LOCAL1")
    state = start_login(c)["state"][0]
    eh.on("POST", "/oauth/tokens", 201, token_body())
    eh.on("GET", "/api/pis/person", 200, {"data": {"id": "P1"}})
    r = c.post("/api/auth/token", json={"code": "GOOD", "state": state})
    assert r.status_code == 200
    assert db.users["P1"] == "U-LOCAL"
    assert db.sessions["LOCAL1"]["ehealth_access_token"] == "EH_AT"


def test_local_session_without_ehealth_has_no_ehealth_access(env):
    c, db, _ = env
    db.add_session("LOCAL1")
    c.set_cookie("pis_session_token", "LOCAL1")
    r = c.get("/api/ehealth/person")
    assert r.status_code == 401 and r.get_json()["ehealth_required"]
    assert c.get("/api/ehealth/person").status_code == 401
    assert c.get("/api/patient/me").get_json()["data"]["ehealth_connected"] is False


def test_unauthenticated(env):
    c, _, _ = env
    assert c.get("/api/ehealth/declarations").status_code == 401
    assert c.get("/api/patient/me").status_code == 401


def test_ehealth_call_uses_pis_endpoint(env):
    c, db, eh = env
    db.add_session("T1", access="AT1", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")
    eh.on("GET", "/api/pis/declarations", 200, {"data": [{"id": "D1"}], "paging": {"page": 1}})
    r = c.get("/api/ehealth/declarations?status=active")
    assert r.status_code == 200 and r.get_json()["data"][0]["id"] == "D1"
    method, path, headers, _ = eh.calls[-1]
    assert headers["Authorization"] == "Bearer AT1"


def test_token_refreshed_before_expiry(env):
    c, db, eh = env
    db.add_session("T1", access="OLD", refresh="RT1", expires_in=30)
    c.set_cookie("pis_session_token", "T1")
    eh.on("POST", "/oauth/tokens", 201, token_body("NEW_AT", refresh=None))
    eh.on("GET", "/api/pis/person", 200, {"data": {"id": "P1"}})
    assert c.get("/api/ehealth/person").status_code == 200
    assert eh.calls[-1][2]["Authorization"] == "Bearer NEW_AT"
    assert db.sessions["T1"]["ehealth_access_token"] == "NEW_AT"
    assert db.sessions["T1"]["ehealth_refresh_token"] == "RT1"


def test_retry_after_401_with_refresh(env):
    c, db, eh = env
    db.add_session("T1", access="REVOKED", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")
    eh.on("GET", "/api/pis/person", 401, {"error": {"type": "access_denied", "message": "Invalid access token"}})
    eh.on("GET", "/api/pis/person", 200, {"data": {"id": "P1"}})
    eh.on("POST", "/oauth/tokens", 201, token_body("NEW_AT"))
    assert c.get("/api/ehealth/person").status_code == 200


def test_failed_refresh_clears_ehealth_tokens(env):
    c, db, eh = env
    db.add_session("T1", access="OLD", refresh="RT1", expires_in=10)
    c.set_cookie("pis_session_token", "T1")
    eh.on("POST", "/oauth/tokens", 401, {"error": {"type": "access_denied", "message": "Invalid refresh token"}})
    r = c.get("/api/ehealth/person")
    assert r.status_code == 401 and r.get_json()["ehealth_required"]
    assert db.sessions["T1"]["ehealth_access_token"] is None


def test_ehealth_error_has_annex1_message(env):
    c, db, eh = env
    db.add_session("T1", access="AT1", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")
    eh.on("POST", "/api/pis/declaration_requests", 409,
          {"error": {"type": "request_conflict", "message": "Division doesn’t exist"}})
    r = c.post("/api/ehealth/declaration-requests", json={"employee_id": "E", "division_id": "X"})
    assert r.status_code == 409
    assert r.get_json()["error"].startswith("Це місце надання послуг неможливо обрати")


def test_network_error_returns_503(env):
    c, db, eh = env
    db.add_session("T1", access="AT1", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")

    def boom(*a, **k):
        raise OSError("timeout")
    eh.request = boom
    assert c.get("/api/ehealth/person").status_code == 503


def test_signed_content_must_be_base64(env):
    c, db, _ = env
    db.add_session("T1", access="AT1", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")
    r = c.patch("/api/ehealth/declaration-requests/R1/sign", json={"signed_content": "@@@"})
    assert r.status_code == 400


def test_document_upload_url_comes_from_ehealth_not_client(env):
    c, db, eh = env
    db.add_session("T1", access="AT1", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")
    eh.on("POST", "/api/pis/documents", 201, {"data": [{"type": "PASSPORT", "url": "https://storage.example/u1"}]})
    eh.on("PUT", "/u1", 200, {})
    import io
    r = c.post("/api/ehealth/documents/upload", data={"type": "PASSPORT", "url": "http://169.254.169.254/",
                                                      "file": (io.BytesIO(b"%PDF"), "pass.pdf")},
               content_type="multipart/form-data")
    assert r.status_code == 200
    assert eh.calls[-1][0] == "PUT" and eh.calls[-1][1] == "/u1"
    r = c.post("/api/ehealth/documents/upload", data={"type": "OTHER", "file": (io.BytesIO(b"x"), "a.pdf")},
               content_type="multipart/form-data")
    assert r.status_code == 400


def test_logout_revokes_ehealth_and_deletes_session(env):
    c, db, eh = env
    db.add_session("T1", access="AT1", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")
    eh.on("POST", "/auth/logout", 200, {"data": {}})
    assert c.post("/api/auth/logout").status_code == 200
    assert ("POST", "/auth/logout") in [(m, p) for m, p, _, _ in eh.calls]
    assert db.deleted == ["T1"]


def test_ehealth_logout_keeps_local_session(env):
    c, db, eh = env
    db.add_session("T1", access="AT1", refresh="RT1")
    c.set_cookie("pis_session_token", "T1")
    eh.on("POST", "/auth/logout", 200, {"data": {}})
    assert c.post("/api/auth/ehealth/logout").status_code == 200
    assert db.sessions["T1"]["ehealth_access_token"] is None and db.deleted == []


def test_sign_in_error_message(env):
    c, _, _ = env
    r = c.post("/api/auth/sign-in-error", json={"error": "invalid_request",
                                               "error_description": "User is blocked."})
    assert "заблоковано" in r.get_json()["error"].lower() or "заблокований" in r.get_json()["error"].lower()


def test_kep_disabled_and_cors_null(env):
    c, _, _ = env
    assert c.post("/api/auth/kep/login", json={}).status_code == 501
    r = c.options("/api/config", headers={"Origin": "null", "Access-Control-Request-Method": "GET"})
    assert r.headers.get("Access-Control-Allow-Origin") != "null"


def test_local_login_token_only_in_cookie(env, monkeypatch):
    c, _, _ = env
    monkeypatch.setattr(ps, "login_local_patient", lambda *a, **k: ({"token": "LT", "user": {"id": "U1"}}, 200))
    r = c.post("/api/auth/local/login", json={"identifier": "a@b.c", "password": "secret1"})
    assert "LT" not in r.get_data(as_text=True)
    assert any(h.startswith("pis_session_token=LT") for h in r.headers.getlist("Set-Cookie"))


def test_unknown_api_path_is_404_not_html(env):
    c, _, _ = env
    assert c.get("/api/declarations").status_code == 404


def test_normalize_phone_and_db_password_required(monkeypatch):
    for raw in ("0984315006", "380984315006", "+38 (098) 431-50-06", "80984315006"):
        assert ps.normalize_phone(raw) == "+380984315006"
    monkeypatch.delenv("PG_PASSWORD", raising=False)
    with pytest.raises(RuntimeError):
        ps.get_db()


def test_token_encryption_roundtrip(monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.setenv("PIS_TOKEN_KEY", Fernet.generate_key().decode())
    enc = ps.encrypt_token("secret-token")
    assert enc != "secret-token" and ps.decrypt_token(enc) == "secret-token"
    monkeypatch.delenv("PIS_TOKEN_KEY")
    with pytest.raises(RuntimeError):
        ps.encrypt_token("x")


def test_client_ip_from_nginx_forwarded_for(env, monkeypatch):
    c, _, _ = env
    seen = {}
    monkeypatch.setattr(ps, "login_local_patient", lambda ident, pwd, ip="", ua="": seen.update(ip=ip) or ({"error": "x"}, 401))
    c.post("/api/auth/local/login", json={"identifier": "a@b.c", "password": "secret1"},
           headers={"X-Forwarded-For": "203.0.113.7"})
    assert seen["ip"] == "203.0.113.7"


VERIFIER = "v" * 20 + "0123456789abcdefghijklmnopqrstuvwxyz"   # 56 символів з алфавіту RFC 7636


def mobile_state(c, verifier=VERIFIER):
    r = c.post("/api/auth-url", json={"env": "pis-app", "code_challenge": A._code_challenge(verifier)})
    assert r.status_code == 200
    return r.get_json()


def test_code_challenge_is_rfc7636_s256():
    # RFC 7636, додаток B
    assert A._code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_mobile_auth_url_returns_signed_state_without_cookie(env):
    c, _, _ = env
    # без code_challenge — відмова (старий застосунок без прив'язки до пристрою)
    assert c.post("/api/auth-url", json={"env": "pis-app"}).status_code == 400
    assert c.post("/api/auth-url", json={"env": "pis-app", "code_challenge": "short"}).status_code == 400
    body = mobile_state(c)
    # повернення через наш хост: розгорнутий на simplex-med.com redirect-ehealth.js знає лише my-dev
    assert body["state"].startswith("my-dev|/ehealth/return/app|")
    assert urllib.parse.parse_qs(urllib.parse.urlparse(body["url"]).query)["state"] == [body["state"]]
    assert c.get_cookie("pis_oauth_state") is None


def test_mobile_token_exchange_requires_signed_state_and_verifier(env, monkeypatch):
    c, db, eh = env
    eh.on("POST", "/oauth/tokens", 201, token_body())
    eh.on("GET", "/api/pis/person", 200, {"data": {"id": "P1"}})
    state = mobile_state(c)["state"]

    def exchange(st, verifier=VERIFIER):
        body = {"code": "C", "state": st, "platform": "MOBILE"}
        if verifier is not None:
            body["code_verifier"] = verifier
        return c.post("/api/auth/token", json=body)

    env_, path, payload = state.split("|")
    # перехоплений code+state без verifier або з чужим verifier — відмова
    assert exchange(state, None).status_code == 400
    assert exchange(state, "w" * 43).status_code == 400
    assert exchange(state, "bad verifier with spaces " * 2).status_code == 400
    # підпис покриває весь state: підміна підпису, шляху чи середовища ламає його
    assert exchange(state[:-4] + "0000").status_code == 400
    assert exchange(f"{env_}|@evil.com|{payload}").status_code == 400
    assert exchange(f"pis-app|{path}|{payload}").status_code == 400
    assert exchange("my|/|x").status_code == 400
    real_time = A.time.time
    monkeypatch.setattr(A.time, "time", lambda: real_time() + A.STATE_MAX_AGE_SECONDS + 5)
    assert exchange(state).status_code == 400
    monkeypatch.setattr(A.time, "time", real_time)
    # жодна відхилена спроба не дійшла до обміну коду в ЕСОЗ
    assert not [call for call in eh.calls if call[1] == "/oauth/tokens"]
    r = exchange(state)
    body = r.get_json()
    assert r.status_code == 200 and body["session_token"].startswith("NEW")
    assert not any(h.startswith("pis_session_token") for h in r.headers.getlist("Set-Cookie"))


def test_web_my_returns_through_our_host(env):
    c, _, _ = env
    q = start_login(c, "my")
    env_, path, nonce = q["state"][0].split("|")
    assert (env_, path) == ("my-dev", "/ehealth/return/my")
    assert c.get_cookie("pis_oauth_state").value == nonce


def test_return_route_forwards_only_to_fixed_targets(env):
    c, _, _ = env
    r = c.get("/ehealth/return/my?code=C1&state=my-dev%7C%2Fehealth%2Freturn%2Fmy%7Cn&next=https://evil.com")
    assert r.status_code == 302
    loc = urllib.parse.urlparse(r.headers["Location"])
    assert (loc.scheme, loc.netloc, loc.path) == ("https", "my.simplex-med.com", "/")
    assert urllib.parse.parse_qs(loc.query) == {"code": ["C1"], "state": ["my-dev|/ehealth/return/my|n"]}
    assert c.get("/ehealth/return/evil.com?code=C1").status_code == 404
    r = c.get("/ehealth/return/app?error=access_denied&error_description=%3C/script%3E%3Cb%3E")
    page = r.get_data(as_text=True)
    assert r.status_code == 200 and r.headers["Referrer-Policy"] == "no-referrer"
    assert "simplexpis://auth/callback?error=access_denied&amp;error_description=%3C%2Fscript%3E%3Cb%3E" in page
    assert "</script><b>" not in page


def test_security_headers(env):
    c, _, _ = env
    r = c.get("/health")
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert "max-age=" in r.headers["Strict-Transport-Security"]
    assert "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]
    assert r.headers["Referrer-Policy"] == "no-referrer"
    assert set(r.get_json()) == {"status"}


def test_cors_only_own_origins(env):
    c, _, _ = env
    for origin in ("http://localhost:5173", "https://app2.simplex-med.com", "https://evil.example"):
        r = c.get("/api/config", headers={"Origin": origin})
        assert r.headers.get("Access-Control-Allow-Origin") is None
    r = c.get("/api/config", headers={"Origin": "https://my.simplex-med.com"})
    assert r.headers.get("Access-Control-Allow-Origin") == "https://my.simplex-med.com"


def test_local_login_rate_limited_per_identifier(env, monkeypatch):
    c, _, _ = env
    monkeypatch.setattr(ps, "login_local_patient", lambda *a, **k: ({"error": "Невірний логін або пароль"}, 401))
    codes = [c.post("/api/auth/local/login", json={"identifier": "a@b.c", "password": "wrong-pass"}).status_code
             for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_register_requires_8_char_password(env):
    c, _, _ = env
    r = c.post("/api/auth/local/register", json={"first_name": "А", "last_name": "Б", "phone": "+380991112233",
                                                  "password": "1234567"})
    assert r.status_code == 400 and "8" in r.get_json()["error"]


def test_web_session_cookie_has_no_max_age(env, monkeypatch):
    c, _, _ = env
    monkeypatch.setattr(ps, "login_local_patient", lambda *a, **k: ({"token": "LT", "user": {"id": "U1"}}, 200))
    r = c.post("/api/auth/local/login", json={"identifier": "x@y.z", "password": "secret12"})
    cookie = [h for h in r.headers.getlist("Set-Cookie") if h.startswith("pis_session_token=")][0]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=Strict" in cookie
    assert "Max-Age" not in cookie and "Expires" not in cookie
