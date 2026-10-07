"""
SimplexMed 2.0 — PIS Standalone API Service (BFF)
Цільові домени:
- https://my-dev.simplex-med.com
- https://my.simplex-med.com

Авторизація:
1. Обліковий запис SimplexMed (Email / Телефон + Пароль, реєстрація) — кабінет SimplexMed.
2. Сервіс авторизації ЕСОЗ (КПІС, OAuth2): лише він дає доступ до даних ЕСОЗ (п.1.5.2).

Токени ЕСОЗ зберігаються тільки на сервері (зашифровані, прив'язані до сесії кабінету),
браузер має лише HttpOnly cookie сесії (п.2.8). Виклики ЕСОЗ — пакет ehealth_pis.

Технічні вимоги до ПІС (Наказ НСЗУ № 978 від 08.12.2025)
"""

import os
import re
import sys
import base64
import html
import ipaddress
import json
import hmac
import hashlib
import logging
import secrets
import threading
import time
from datetime import datetime, timezone
from functools import wraps
from urllib.parse import urlencode

from flask import Flask, request, jsonify, make_response, send_from_directory
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# Секрети і налаштування з .env у корені розгортання (pm2/systemd можуть не передавати оточення);
# змінні, задані в оточенні процесу, мають пріоритет
try:
    from dotenv import load_dotenv
    load_dotenv(os.getenv("PIS_ENV_FILE") or os.path.join(PROJECT_ROOT, ".env"), override=False)
except ImportError:
    pass

import pis_service  # noqa: E402
from ca_proxy import CaProxy, ProxyError  # noqa: E402
from ehealth_pis import EhealthApiError, PisClient, PisConfig  # noqa: E402
from ehealth_pis.registration import (clean_person, person_request_sign_content, sign_up_content,  # noqa: E402
                                     validate_person_request, validate_person_update)
from ehealth_pis.declarations import MSG_NO_CONTRACT, declaration_sign_content, limit_warning, sign_result_message  # noqa: E402
from ehealth_pis.registry import RegistryStore, age_from_birth_date, allowed_specialities, start_background_refresh  # noqa: E402
from ehealth_pis.errors import next_step  # noqa: E402
from ehealth_pis.signing import is_base64  # noqa: E402
from ehealth_pis.verification import verification_view  # noqa: E402

WEB_DIR = os.path.join(PROJECT_ROOT, "web")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("pis_api")

app = Flask(__name__, static_folder=WEB_DIR)
if os.getenv("PIS_TRUST_PROXY", "1") != "0":
    # Сервіс слухає лише 127.0.0.1 за nginx: IP клієнта і схему беремо з X-Forwarded-* (один проксі)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config["MAX_CONTENT_LENGTH"] = 21 * 1024 * 1024  # копії документів до 20 МБ (п.3.6.1)
# Лише власні origin кабінету. Для локальної розробки — PIS_CORS_ORIGINS="http://localhost:5173,..."
CORS_ORIGINS = [o.strip() for o in os.getenv(
    "PIS_CORS_ORIGINS", "https://my-dev.simplex-med.com,https://my.simplex-med.com").split(",") if o.strip()]
CORS(app, supports_credentials=True, origins=CORS_ORIGINS)

PORT = int(os.getenv("PIS_PORT", 3122))
# Власний обліковий запис SimplexMed (телефон/email + пароль). КПІС не може мати проміжних інтерфейсів
# авторизації, крім сервісу авторизації ЕСОЗ (п.1.5.2 ТВ ПІС), тому за замовчуванням вимкнено.
LOCAL_ACCOUNTS = os.getenv("PIS_LOCAL_ACCOUNTS", "0") == "1"
# Конфігураційний параметр Системи PIS_PERSON_LEGAL_CAPACITY_DOCUMENT_TYPES (п.3.5.4.13, 3.10.1.3.1): типи документів,
# що посвідчують дієздатність (14–18 років). Значення видає НСЗУ; порожньо — усі типи, крім документів особи.
# Типове значення — документи з довідника DOCUMENT_TYPE ЕСОЗ, що підтверджують набуття повної цивільної
# дієздатності до 18 років (ЦК України, ст. 35: шлюб, рішення суду/органу опіки, реєстрація підприємцем).
DEFAULT_LEGAL_CAPACITY_DOCUMENT_TYPES = ("MARRIAGE_CERTIFICATE,DIVORCE_CERTIFICATE,COURT_DECISION_DIVORCE,"
                                         "COURT_DECISION_LEGAL_CAPACITY,GUARDIANSHIP_DECISION_LEGAL_CAPACITY,"
                                         "LEGAL_CAPACITY_DOCUMENT,STATE_REGISTER_EXTRACT")
LEGAL_CAPACITY_DOCUMENT_TYPES = [t.strip() for t in os.getenv("PIS_LEGAL_CAPACITY_DOCUMENT_TYPES",
                                                              DEFAULT_LEGAL_CAPACITY_DOCUMENT_TYPES).split(",")
                                 if t.strip()]
# Лише локальний інтерфейс: назовні сервіс доступний тільки через nginx із TLS (п.2.7)
HOST = os.getenv("PIS_HOST", "127.0.0.1")
SESSION_COOKIE = "pis_session_token"
OAUTH_STATE_COOKIE = "pis_oauth_state"
# Середовища, які клієнт може передати в /api/auth-url ("pis-app" — мобільний застосунок)
ALLOWED_STATE_ENVS = {"my-dev", "my", "pis-app"}
MOBILE_STATE_ENVS = {"pis-app"}
# ЕСОЗ повертає код на зареєстрований redirect_uri (simplex-med.com), а redirect-ehealth.js там
# розподіляє його за state "<env>|<шлях>|<nonce>". Розгорнута там версія скрипту знає лише my-dev,
# тому my і застосунок повертаються через наш маршрут на цьому хості: <RETURN_VIA_ENV>|/ehealth/return/<ціль>.
# Ціль фіксована на сервері — маршрут не може перенаправити на довільну адресу.
RETURN_VIA_ENV = os.getenv("PIS_RETURN_VIA_ENV", "my-dev")
RETURN_PATH_PREFIX = "/ehealth/return/"
RETURN_TARGETS = {
    "app": os.getenv("PIS_APP_REDIRECT", "simplexpis://auth/callback"),
    "my": os.getenv("PIS_MY_URL", "https://my.simplex-med.com/"),
}
MOBILE_RETURN_PATH = RETURN_PATH_PREFIX + "app"
# Застосунок не має cookie: state підписується HMAC разом із code_challenge (SHA-256 від одноразового
# code_verifier, який знає лише пристрій). Перехоплений code+state без verifier обміняти не можна.
STATE_MAX_AGE_SECONDS = 600
CODE_CHALLENGE_RE = re.compile(r"[A-Za-z0-9_-]{43}")
CODE_VERIFIER_RE = re.compile(r"[A-Za-z0-9._~-]{43,128}")
# Окремий ключ для state: PIS_STATE_KEY або похідний від PIS_TOKEN_KEY (не той самий секрет для двох цілей)
_STATE_KEY = (os.getenv("PIS_STATE_KEY", "").encode() or
              (hashlib.sha256(b"pis-oauth-state|" + os.getenv("PIS_TOKEN_KEY", "").encode()).digest()
               if os.getenv("PIS_TOKEN_KEY") else secrets.token_bytes(32)))
# Оновлюємо Access token заздалегідь, щоб він не сплив посеред запиту (п.1.4.1)
REFRESH_MARGIN_SECONDS = 120

_DEFAULT_CRED_FILE = os.path.join(os.path.dirname(PROJECT_ROOT), "eHealth Cred",
                                  "Credentials to PIS SimplexMed", "Credentials to PIS SimplexMed.txt")
os.environ.setdefault("PIS_CRED_FILE", _DEFAULT_CRED_FILE)
ehealth = PisClient(PisConfig.from_env())
# Бібліотека підпису ІІТ і дані ЦСК (pis/tools/fetch_euscp.py)
ca_proxy = CaProxy(os.path.join(WEB_DIR, "lib", "euscp", "data", "CAs.json"))
# Кеш реєстрів, довідників і адрес ЕСОЗ (п.3.12): оновлення не частіше 4 год і не рідше доби
registry = RegistryStore(os.getenv("PIS_REGISTRY_DB", os.path.join(BACKEND_DIR, "registry.sqlite3")))
# Довідники, потрібні формам кабінету (запити до ЕСОЗ лише з цього переліку)
PUBLIC_DICTIONARIES = {"COUNTRY", "GENDER", "DOCUMENT_TYPE", "ADDRESS_TYPE", "SETTLEMENT_TYPE", "STREET_TYPE",
                       "PHONE_TYPE", "AUTHENTICATION_METHOD", "SCOPES", "PREFERRED_WAY_COMMUNICATION",
                       "SPECIALITY_TYPE", "EDUCATION_DEGREE", "QUALIFICATION_TYPE", "SPECIALITY_LEVEL",
                       "SPEC_QUALIFICATION_TYPE", "DIVISION_TYPE", "POSITION", "SCIENCE_DEGREE",
                       # Причини статусу декларації в ЕСОЗ — довідник DECLARATION_REASONS (DECLARATION_STATUS_REASON
                       # на preprod порожній; лишаємо для сумісності), статуси — DECLARATION_STATUSES
                       "DECLARATION_REASONS", "DECLARATION_STATUSES",
                       "DECLARATION_STATUS_REASON", "DECLARATION_REQUEST_STATUS_REASON",
                       "PERSON_VERIFICATION_STATUSES", "PERSON_VERIFICATION_STATUS_REASONS"}


# Заголовки безпеки (п.2.3, 2.7): лише HTTPS, без вбудовування в чужі сторінки, без витоку адрес
SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
}


@app.after_request
def set_cache_headers(response):
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    if request.path.startswith("/lib/euscp/"):
        # Бібліотека ІІТ закріплена за версією (worker ~17 МБ) — кешуємо; дані ЦСК перевіряємо за ETag
        response.headers["Cache-Control"] = ("public, max-age=604800" if request.path.endswith(".js")
                                             else "no-cache")
        return response
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# ------------------------------------------------------------------------------
# 1. СЕСІЯ КАБІНЕТУ І ТОКЕНИ ЕСОЗ
# ------------------------------------------------------------------------------

# Мережі Cloudflare (https://www.cloudflare.com/ips/). Кабінет працює за Cloudflare: nginx бачить адресу вузла
# Cloudflare, а адресу користувача Cloudflare передає в CF-Connecting-IP. Довіряємо цьому заголовку лише тоді,
# коли запит справді прийшов із мережі Cloudflare; інакше його міг підставити сам клієнт (обхід обмежень частоти).
CLOUDFLARE_NETWORKS = [ipaddress.ip_network(n) for n in os.getenv("PIS_CLOUDFLARE_CIDRS", " ".join((
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
    "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32",
    "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"))).split()]


def _from_cloudflare(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in CLOUDFLARE_NETWORKS)


def _client_ip():
    """
    IP користувача: адреса, яку передав nginx (ProxyFix, один проксі); якщо це вузол Cloudflare —
    адреса з CF-Connecting-IP. Від інших адрес заголовок CF-Connecting-IP ігнорується.
    """
    peer = (request.remote_addr or "").strip()
    cf_ip = (request.headers.get("CF-Connecting-IP") or "").strip()
    if cf_ip and _from_cloudflare(peer):
        try:
            return str(ipaddress.ip_address(cf_ip))
        except ValueError:
            pass
    return peer[:64]


# Обмеження частоти запитів (п.2.x: захист від підбору пароля і зловживання ключем ЕСОЗ).
# Лічильники в пам'яті процесу: на кожен робочий процес gunicorn — свій ліміт.
_rate_lock = threading.Lock()
_rate_hits = {}


def _rate_limited(bucket, key, limit, window_seconds):
    """True, якщо для (bucket, key) за останні window_seconds уже було limit звернень; інакше рахує звернення."""
    now = time.monotonic()
    with _rate_lock:
        if len(_rate_hits) > 50000:
            _rate_hits.clear()
        hits = [t for t in _rate_hits.get((bucket, key), ()) if now - t < window_seconds]
        if len(hits) >= limit:
            _rate_hits[(bucket, key)] = hits
            return True
        hits.append(now)
        _rate_hits[(bucket, key)] = hits
        return False


def rate_limit(bucket, limit, window_seconds):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if _rate_limited(bucket, _client_ip(), limit, window_seconds):
                return jsonify({"error": "Забагато спроб. Спробуйте пізніше."}), 429
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def _session_token():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):  # мобільний клієнт
        return auth_header[7:].strip()
    return request.cookies.get(SESSION_COOKIE)


def _current_session():
    token = _session_token()
    return pis_service.get_session(token) if token else None


def _is_web():
    return (request.get_json(silent=True) or {}).get("platform", "WEB").upper() == "WEB"


def _set_session_cookie(response, token):
    # Сесійна cookie (без max_age): зникає із закриттям браузера; на сервері сесія ще й завершується
    # після бездіяльності (pis_service.WEB_IDLE_TIMEOUT)
    response.set_cookie(SESSION_COOKIE, token, httponly=True, secure=True, samesite="Strict")


def _ehealth_error(err, session=None):
    if err.status == 401 and session:
        pis_service.clear_session_ehealth_tokens(session["session_id"])
        body = err.to_dict()
        body["ehealth_required"] = True
        return jsonify(body), 401
    status = err.status if 400 <= err.status < 500 else (503 if err.status == 0 else 502)
    logger.warning(f"eHealth error {err}")
    return jsonify(err.to_dict()), status


def _refresh_tokens(session):
    tokens = ehealth.refresh(session["ehealth_refresh_token"])
    pis_service.set_session_ehealth_tokens(session["session_id"], tokens.access_token,
                                           tokens.refresh_token, tokens.expires_at)
    session["ehealth_access_token"] = tokens.access_token
    session["ehealth_refresh_token"] = tokens.refresh_token
    session["ehealth_expires_at"] = datetime.fromtimestamp(tokens.expires_at, timezone.utc)
    return tokens.access_token


def _expires_soon(session):
    expires_at = session.get("ehealth_expires_at")
    if not expires_at:
        return True
    return (expires_at - datetime.now(timezone.utc)).total_seconds() <= REFRESH_MARGIN_SECONDS


class FieldErrors(Exception):
    def __init__(self, errors):
        super().__init__("field errors")
        self.errors = errors


def ehealth_route(fn):
    """
    Виконує fn(access_token, ...) з дійсним токеном ЕСОЗ сесії: оновлює його за
    refresh_token, якщо строк спливає (п.1.4.1), і повторює запит один раз після 401.
    Помилки ЕСОЗ повертає з повідомленням для користувача за Додатком 1.
    """
    @wraps(fn)
    def wrapper(*args, **kwargs):
        session = _current_session()
        if not session:
            return jsonify({"error": "Потрібна авторизація"}), 401
        if not session.get("ehealth_access_token"):
            return jsonify({"error": "Увійдіть через ЕСОЗ (eHealth), щоб переглянути ці дані",
                            "ehealth_required": True}), 401
        try:
            token = session["ehealth_access_token"]
            if _expires_soon(session) and session.get("ehealth_refresh_token"):
                token = _refresh_tokens(session)
            try:
                result = fn(token, *args, **kwargs)
            except EhealthApiError as e:
                if e.status != 401 or not session.get("ehealth_refresh_token"):
                    raise
                result = fn(_refresh_tokens(session), *args, **kwargs)
        except EhealthApiError as e:
            return _ehealth_error(e, session)
        except FieldErrors as e:
            return jsonify({"error": "Перевірте дані форми",
                            "fields": [{"field": f, "message": m} for f, m in e.errors]}), 422
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if result is None:
            return "", 204
        return jsonify(result), 200
    return wrapper


def _json():
    return request.get_json(silent=True) or {}


def _paging():
    return {k: request.args.get(k) for k in ("page", "page_size")}


# ------------------------------------------------------------------------------
# 2. СИСТЕМНІ ЕНДПОІНТИ ТА КОНФІГУРАЦІЯ
# ------------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "healthy",
    }), 200


@app.route("/api/config", methods=["GET"])
def get_config():
    cfg = ehealth.config
    return jsonify({
        "client_id": cfg.client_id,
        "auth_host": cfg.login_host,
        "redirect_uri": cfg.redirect_uri,
        "scopes": list(cfg.scopes),
        "pis_name": cfg.pis_name,
        "support_contacts": cfg.support_contacts,
        "local_accounts": LOCAL_ACCOUNTS,
        "legal_capacity_document_types": LEGAL_CAPACITY_DOCUMENT_TYPES,
    }), 200


@app.route("/api/privacy-policy", methods=["GET"])
def get_privacy_policy():
    """Політика конфіденційності з можливістю зберегти як текстовий файл (п.3.3.1.1)."""
    policy_file = os.path.join(WEB_DIR, "privacy_policy.txt")
    if not os.path.exists(policy_file):
        return jsonify({"error": "Privacy policy file not found"}), 404
    with open(policy_file, "r", encoding="utf-8") as f:
        content = f.read()
    resp = make_response(content)
    resp.headers["Content-Type"] = "text/plain; charset=utf-8"
    disposition = "attachment" if request.args.get("download") else "inline"
    resp.headers["Content-Disposition"] = f"{disposition}; filename=privacy_policy.txt"
    return resp


# ------------------------------------------------------------------------------
# 3. ВЛАСНИЙ ОБЛІКОВИЙ ЗАПИС SIMPLEXMED
# ------------------------------------------------------------------------------

def local_accounts_only(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not LOCAL_ACCOUNTS:
            return jsonify({"error": "Not found"}), 404
        return fn(*args, **kwargs)
    return wrapper


def _local_auth_response(resp_json, status_code):
    token = resp_json.pop("token", None) if _is_web() else resp_json.get("token")
    response = make_response(jsonify(resp_json), status_code)
    if status_code in (200, 201) and token:
        _set_session_cookie(response, token)
    return response


@app.route("/api/auth/local/register", methods=["POST"])
@local_accounts_only
@rate_limit("register", 5, 3600)
def register_local():
    data = _json()
    first_name = data.get("first_name", "").strip()
    last_name = data.get("last_name", "").strip()
    phone = data.get("phone", "").strip()
    password = data.get("password", "")
    if not first_name or not last_name or not phone or not password:
        return jsonify({"error": "Будь ласка, заповніть обов'язкові поля: Прізвище, Ім'я, Телефон, Пароль"}), 400
    if len(password) < 8:
        return jsonify({"error": "Пароль повинен містити щонайменше 8 символів"}), 400
    resp_json, status_code = pis_service.register_local_patient(
        first_name=first_name, last_name=last_name, second_name=data.get("second_name", "").strip(),
        phone=phone, email=data.get("email", "").strip() or None, password=password,
        tax_id=data.get("tax_id", "").strip() or None)
    return _local_auth_response(resp_json, status_code)


@app.route("/api/auth/local/login", methods=["POST"])
@local_accounts_only
@rate_limit("login-ip", 20, 900)
def login_local():
    data = _json()
    identifier = data.get("identifier", "").strip()
    password = data.get("password", "")
    if not identifier or not password:
        return jsonify({"error": "Введіть логін (телефон або email) та пароль"}), 400
    # Не більше 5 спроб на один логін за 15 хвилин — незалежно від IP і запису номера (0XX…, +380…, з пробілами)
    login_key = identifier.lower() if "@" in identifier else pis_service.normalize_phone(identifier)
    if _rate_limited("login-id", login_key, 5, 900):
        return jsonify({"error": "Забагато спроб входу. Спробуйте через 15 хвилин."}), 429
    resp_json, status_code = pis_service.login_local_patient(
        identifier, password, ip=_client_ip(), ua=request.headers.get("User-Agent", ""))
    return _local_auth_response(resp_json, status_code)


@app.route("/api/auth/kep/login", methods=["POST"])
@local_accounts_only
def login_kep():
    resp_json, status_code = pis_service.login_kep_patient(None, None, None)
    return jsonify(resp_json), status_code


# ------------------------------------------------------------------------------
# 4. АВТОРИЗАЦІЯ ПАЦІЄНТА В ЕСОЗ (КПІС, п.3.3 / 3.7)
# ------------------------------------------------------------------------------

@app.route("/api/auth/nonce", methods=["POST"])
@rate_limit("nonce", 30, 60)
def get_nonce():
    """п.3.3.2: JWT для підпису ЕП користувачем перед переходом на сервіс авторизації."""
    try:
        return jsonify({"nonce": ehealth.get_nonce()}), 200
    except EhealthApiError as e:
        return _ehealth_error(e)


@app.route("/api/auth/sign-up/prepare", methods=["POST"])
@rate_limit("sign-up-prepare", 20, 60)
def prepare_sign_up():
    """
    п.3.5.2–3.5.5: перевіряє дані форми реєстрації і повертає контент для підпису ЕП:
    JSON {person, patient_signed, process_disclosure_data_consent, jwt=nonce}.
    """
    person = _json().get("person")
    errors = validate_person_request(person) if isinstance(person, dict) else [("person", "Дані пацієнта відсутні")]
    if errors:
        return jsonify({"error": "Перевірте дані форми реєстрації",
                        "fields": [{"field": f, "message": m} for f, m in errors]}), 422
    try:
        nonce = ehealth.get_nonce()
    except EhealthApiError as e:
        return _ehealth_error(e)
    return jsonify({"content": sign_up_content(clean_person(person), nonce)}), 200


@app.route("/api/auth-url", methods=["GET", "POST"])
@rate_limit("auth-url", 30, 60)
def get_auth_url():
    """
    URL сервісу авторизації ЕСОЗ.
    Зареєстрований redirect_uri: https://simplex-med.com, далі redirect-ehealth.js за state.
    POST {env, user_data, mode}:
      mode=sign-in (за замовчуванням): user_data — base64 підписаного ЕП nonce (п.3.3.3–3.3.4);
        без user_data сервіс авторизації сам запропонує способи входу;
      mode=sign-up: user_data — base64 підписаної форми реєстрації (п.3.5.6), обов'язково.
    """
    params = _json() if request.method == "POST" else request.args
    env = params.get("env", "my-dev")
    if env not in ALLOWED_STATE_ENVS:
        return jsonify({"error": "Невідоме середовище"}), 400
    mode = params.get("mode", "sign-in")
    if mode not in ("sign-in", "sign-up"):
        return jsonify({"error": "Невідомий режим авторизації"}), 400
    user_data = params.get("user_data") or None
    if user_data and not is_base64(user_data):
        return jsonify({"error": "Підписані дані мають бути в форматі BASE64"}), 400
    if mode == "sign-up" and not user_data:
        return jsonify({"error": "Підпишіть дані для реєстрації електронним підписом"}), 400

    # Одноразовий nonce у state захищає від підміни коду авторизації (OAuth CSRF):
    # веб — nonce у HttpOnly cookie; мобільний застосунок — state, підписаний разом із code_challenge
    mobile = env in MOBILE_STATE_ENVS
    if mobile:
        challenge = params.get("code_challenge") or ""
        if not CODE_CHALLENGE_RE.fullmatch(challenge):
            return jsonify({"error": "Оновіть застосунок: відсутній code_challenge"}), 400
        try:
            state = _mobile_state(challenge, mode)
        except ValueError as e:
            return jsonify({"error": str(e)}), 503
    else:
        nonce = secrets.token_urlsafe(24)
        if env == "my" and RETURN_VIA_ENV != "my":
            state = f"{RETURN_VIA_ENV}|{RETURN_PATH_PREFIX}my|{nonce}"
        else:
            state = f"{env}|/|{nonce}"
    if mode == "sign-up":
        url = ehealth.sign_up_url(user_data=user_data, state=state)
    else:
        url = ehealth.sign_in_url(state=state, user_data=user_data)
    response = make_response(jsonify({"url": url, "state": state} if mobile else {"url": url}), 200)
    if not mobile:
        response.set_cookie(OAUTH_STATE_COOKIE, nonce, httponly=True, secure=True, samesite="Lax", max_age=600)
    return response


def _code_challenge(verifier):
    """RFC 7636 S256: BASE64URL(SHA256(verifier)) без доповнення."""
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


# ------------------------------------------------------------------------------
# Вхід мобільного застосунку. ЕСОЗ не підтримує PKCE, тому код авторизації в застосунок не передається
# зовсім: його обмінює сервер на сторінці повернення /ehealth/return/app (code і state приходять туди
# разом через HTTPS), а застосунок отримує одноразовий handle і забирає сесію лише з code_verifier.
# Перехоплене посилання simplexpis:// (інший застосунок із тією самою схемою) нічого не дає без verifier,
# а код ЕСОЗ до обміну не залишає браузер.
# Стан — у пам'яті процесу: gunicorn працює одним воркером (backend/gunicorn.conf.py).
# ------------------------------------------------------------------------------
MOBILE_HANDLE_TTL_SECONDS = 180
_mobile_lock = threading.Lock()
_mobile_logins = {}   # rand зі state -> {challenge, mode, created, handle, status, body, finished}


def _mobile_state_sig(body, challenge):
    message = f"{RETURN_VIA_ENV}|{MOBILE_RETURN_PATH}|{body}|{challenge}".encode()
    return hmac.new(_STATE_KEY, message, hashlib.sha256).hexdigest()[:32]


def _purge_mobile_logins(now):
    for key in [k for k, v in _mobile_logins.items()
                if now - v["created"] > STATE_MAX_AGE_SECONDS + MOBILE_HANDLE_TTL_SECONDS]:
        del _mobile_logins[key]


def _mobile_state(challenge, mode="sign-in"):
    now = time.time()
    rand = secrets.token_urlsafe(18)
    body = f"{int(now)}.{rand}"
    with _mobile_lock:
        _purge_mobile_logins(now)
        if len(_mobile_logins) > 20000:
            raise ValueError("Забагато одночасних входів. Спробуйте пізніше.")
        _mobile_logins[rand] = {"challenge": challenge, "mode": mode, "created": now, "handle": None}
    return f"{RETURN_VIA_ENV}|{MOBILE_RETURN_PATH}|{body}.{_mobile_state_sig(body, challenge)}"


def _state_rand(state):
    """Випадкова частина мобільного state: "<env>|<шлях>|<час>.<rand>.<підпис>"."""
    parts = (state or "").split("|")
    if len(parts) != 3:
        return None
    pieces = parts[2].split(".")
    return pieces[1] if len(pieces) == 3 else None


def _pending_mobile_login(state):
    """Запис входу за state, якщо state виданий цим сервером, свіжий і ще не використаний."""
    parts = (state or "").split("|")
    if len(parts) != 3 or parts[0] != RETURN_VIA_ENV or parts[1] != MOBILE_RETURN_PATH:
        return None
    try:
        ts, rand, sig = parts[2].split(".")
        age = time.time() - int(ts)
    except ValueError:
        return None
    entry = _mobile_logins.get(rand)
    if (not entry or entry["handle"] or not 0 <= age <= STATE_MAX_AGE_SECONDS
            or not hmac.compare_digest(sig, _mobile_state_sig(f"{ts}.{rand}", entry["challenge"]))):
        return None
    return entry


def _sign_in_error_body(error, description, mode):
    """Текст для користувача за помилкою сервісу авторизації (error/error_description, RFC 6749)."""
    if error == "access_denied":
        return {"error": "Авторизацію скасовано: доступ до даних не надано", "action": "", "next_step": None}
    # Помилки сервісу реєстрації — за рядками "PIS. Patient sign-up" Додатку 1 (п.3.5.6.1), інакше sign-in
    description = str(description or "")[:2000]
    methods = (["PIS. Patient sign-up"] if mode == "sign-up" else []) + ["PIS. Patient sign-in"]
    message, action = None, ""
    for method in methods:
        message, action = ehealth.annex.resolve(method, None, description)
        if message != ehealth.annex.generic_message():
            break
    return {"error": message, "action": action, "next_step": next_step(action)}


def _complete_ehealth_login(code, session, platform):
    """
    Обмін grant code на токени ЕСОЗ (п.3.3.6), прив'язка персони і сесія кабінету.
    Повертає (тіло відповіді, HTTP-статус, токен нової сесії або None).
    """
    try:
        tokens = ehealth.exchange_code(code)
        person = ehealth.get_person(tokens.access_token).get("data") or {}
    except EhealthApiError as e:
        logger.warning(f"eHealth login failed: {e.api_method}: HTTP {e.status} {e.error_type}")
        status = e.status if 400 <= e.status < 500 else (503 if e.status == 0 else 502)
        return e.to_dict(), status, None
    try:
        user_id, conflict = pis_service.link_ehealth_person(person, current_user_id=session["id"] if session else None)
    except ValueError:
        return {"error": "Не вдалося отримати профіль пацієнта з ЕСОЗ"}, 502, None
    if conflict:
        try:
            ehealth.logout(tokens.access_token)
        except EhealthApiError:
            pass
        return {"error": "Цей обліковий запис SimplexMed уже пов'язано з іншим пацієнтом ЕСОЗ. "
                         "Вийдіть і увійдіть через ЕСОЗ без локального облікового запису."}, 409, None
    new_session_token = None
    if session and str(session["id"]) == str(user_id):
        session_id = session["session_id"]
    else:
        new_session_token, session_id = pis_service.create_session(
            user_id, platform, _client_ip(), request.headers.get("User-Agent", ""))
    pis_service.set_session_ehealth_tokens(session_id, tokens.access_token, tokens.refresh_token,
                                           tokens.expires_at, person.get("id"))
    body = {"message": "Авторизація через ЕСОЗ успішна", "user_id": str(user_id), "ehealth_connected": True}
    return body, 200, new_session_token


_APP_RETURN_PAGE = """<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Повернення до застосунку «Плексі»</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:64px auto;padding:24px;text-align:center;color:#0f172a">
<h1 style="font-size:20px">{title}</h1>
<p style="color:#475569">Поверніться до застосунку «Плексі», щоб продовжити.</p>
<a href="{href}" style="display:inline-block;margin-top:12px;padding:14px 24px;min-height:44px;background:#273fcc;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Повернутися до застосунку</a>
<script>window.location.replace({target});</script>
</body></html>"""


def _app_return_page(query, title):
    destination = RETURN_TARGETS["app"]
    url = destination + ("&" if "?" in destination else "?") + urlencode(query)
    page = (_APP_RETURN_PAGE.replace("{title}", html.escape(title))
            .replace("{href}", html.escape(url, quote=True))
            .replace("{target}", json.dumps(url).replace("<", "\\u003c")))
    response = make_response(page, 200)
    response.headers["Content-Type"] = "text/html; charset=utf-8"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.route(RETURN_PATH_PREFIX + "<target>", methods=["GET"])
@rate_limit("return", 30, 60)
def ehealth_return(target):
    """
    Друга ланка повернення з ЕСОЗ (після redirect-ehealth.js).
    my  — передає code/state або error у кабінет my.simplex-med.com (обмін робить кабінет із cookie state);
    app — сам обмінює code на сесію і відкриває застосунок з одноразовим handle (без коду ЕСОЗ).
    Застосунок відкривається зі сторінки з кнопкою: браузер може не відкрити схему без дії користувача.
    """
    destination = RETURN_TARGETS.get(target)
    if not destination:
        return jsonify({"error": "Not found"}), 404
    if target != "app":
        query = urlencode([(k, request.args[k]) for k in ("code", "state", "error", "error_description")
                           if k in request.args])
        response = make_response("", 302)
        response.headers["Location"] = destination + ("&" if "?" in destination else "?") + query
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    state = request.args.get("state", "")
    with _mobile_lock:
        entry = _pending_mobile_login(state)
        if entry:
            entry["handle"] = "pending"     # повторне відкриття цього посилання не обмінює код ще раз
    if not entry:
        return _app_return_page({"error": "expired_state", "state": state}, "Сесія входу застаріла")
    session_token = None
    if request.args.get("error"):
        body, status = _sign_in_error_body(request.args["error"], request.args.get("error_description"),
                                           entry["mode"]), 400
    elif request.args.get("code"):
        body, status, session_token = _complete_ehealth_login(request.args["code"], None, "MOBILE")
    else:
        body, status = {"error": "Сервіс авторизації ЕСОЗ не повернув код авторизації"}, 400
    if session_token:
        body["session_token"] = session_token
    handle = secrets.token_urlsafe(32)
    with _mobile_lock:
        entry.update(handle=handle, status=status, body=body, finished=time.time())
    title = "Авторизацію в ЕСОЗ завершено" if status == 200 else "Авторизацію в ЕСОЗ не завершено"
    return _app_return_page({"handle": handle, "state": state}, title)


@app.route("/api/auth/mobile/redeem", methods=["POST"])
@rate_limit("redeem", 30, 60)
def mobile_redeem():
    """
    Застосунок забирає результат входу: handle з посилання simplexpis:// + code_verifier, який знає лише він.
    Одноразово і протягом кількох хвилин після повернення з ЕСОЗ.
    """
    data = _json()
    handle, verifier, rand = str(data.get("handle") or ""), data.get("code_verifier"), _state_rand(data.get("state"))
    expired = jsonify({"error": "Сесія входу через ЕСОЗ застаріла. Почніть вхід ще раз"}), 400
    if not isinstance(verifier, str) or not CODE_VERIFIER_RE.fullmatch(verifier) or not handle or not rand:
        return expired
    challenge = _code_challenge(verifier)
    with _mobile_lock:
        entry = _mobile_logins.get(rand)
        if (not entry or entry["handle"] in (None, "pending") or not hmac.compare_digest(entry["handle"], handle)
                or time.time() - entry["finished"] > MOBILE_HANDLE_TTL_SECONDS
                or not hmac.compare_digest(entry["challenge"], challenge)):
            return expired
        del _mobile_logins[rand]
    return jsonify(entry["body"]), entry["status"]


@app.route("/api/auth/sign-in-error", methods=["POST"])
@rate_limit("sign-in-error", 30, 60)
def sign_in_error():
    """Помилка, з якою сервіс авторизації повернув користувача у веб-кабінет (error/error_description, RFC 6749)."""
    data = _json()
    return jsonify(_sign_in_error_body(data.get("error"), data.get("error_description"), data.get("mode"))), 200


@app.route("/api/auth/token", methods=["POST"])
@rate_limit("token", 20, 60)
def exchange_token():
    """
    Обмін grant code на токени ЕСОЗ у веб-кабінеті (п.3.3.6). Токени лишаються на сервері; браузер
    отримує лише cookie сесії кабінету. state має містити nonce з HttpOnly cookie цього браузера.
    Мобільний застосунок код не отримує (див. /ehealth/return/app і /api/auth/mobile/redeem).
    """
    data = _json()
    code = data.get("code")
    state = data.get("state") or ""
    if data.get("platform", "WEB").upper() != "WEB":
        return jsonify({"error": "Оновіть застосунок до останньої версії"}), 400
    if not code:
        return jsonify({"error": "Відсутній authorization code"}), 400
    parts = state.split("|")
    expected = request.cookies.get(OAUTH_STATE_COOKIE) or ""
    if not (len(parts) == 3 and expected and hmac.compare_digest(parts[2], expected)):
        return jsonify({"error": "Сесія входу через eHealth застаріла. Почніть вхід ще раз"}), 400

    body, status, new_session_token = _complete_ehealth_login(code, _current_session(), "WEB")
    response = make_response(jsonify(body), status)
    response.delete_cookie(OAUTH_STATE_COOKIE, secure=True, httponly=True, samesite="Lax")
    if new_session_token:
        _set_session_cookie(response, new_session_token)
    return response


def _ehealth_logout(session):
    """Припинення дії токенів ЕСОЗ (п.3.7.1). Повертає текст помилки за Додатком 1 (п.3.7.1.1) або None."""
    if session and session.get("ehealth_access_token"):
        try:
            ehealth.logout(session["ehealth_access_token"])
        except EhealthApiError as e:
            logger.warning(f"eHealth logout failed: {e}")
            return e.to_dict()["error"]
    return None


@app.route("/api/auth/ehealth/logout", methods=["POST"])
def ehealth_logout():
    """Припинити дію токенів ЕСОЗ, залишивши сесію облікового запису SimplexMed (п.3.7)."""
    session = _current_session()
    if not session:
        return jsonify({"error": "Потрібна авторизація"}), 401
    warning = _ehealth_logout(session)
    pis_service.clear_session_ehealth_tokens(session["session_id"])
    return jsonify({"message": "Доступ до ЕСОЗ у цій сесії припинено", "warning": warning}), 200


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    """Вихід: припинення токенів ЕСОЗ (п.3.7) і видалення сесії кабінету."""
    warning = None
    try:
        session = _current_session()
        warning = _ehealth_logout(session)
        pis_service.delete_session(_session_token())
    except Exception as e:
        logger.warning(f"Failed to delete session on logout: {e}")
    response = make_response(jsonify({"message": "Сесію успішно завершено", "warning": warning}), 200)
    response.delete_cookie(SESSION_COOKIE, secure=True, httponly=True, samesite="Strict")
    return response


@app.route("/api/account", methods=["DELETE"])
@rate_limit("account-delete", 5, 3600)
def delete_account():
    """
    Видалення облікового запису кабінету «Плексі» самим користувачем: обліковий запис, особисті відомості
    й усі сесії на всіх пристроях; дія токенів ЕСОЗ припиняється (п.3.7). Записи про пацієнта в ЕСОЗ
    залишаються — їх веде держава, кабінет їх не видаляє.
    """
    session = _current_session()
    if not session:
        return jsonify({"error": "Потрібна авторизація"}), 401
    if (_json().get("confirm") or "") != "DELETE":
        return jsonify({"error": "Підтвердьте видалення облікового запису"}), 400
    try:
        tokens = pis_service.delete_account(session["id"])
    except Exception as e:
        logger.error(f"Account delete failed: {type(e).__name__}")
        return jsonify({"error": "Не вдалося видалити обліковий запис. Спробуйте пізніше"}), 500
    for token in tokens:
        try:
            ehealth.logout(token)
        except EhealthApiError as e:
            logger.warning(f"eHealth logout on account delete failed: HTTP {e.status}")
    response = make_response(jsonify({"message": "Обліковий запис видалено"}), 200)
    response.delete_cookie(SESSION_COOKIE, secure=True, httponly=True, samesite="Strict")
    return response


# ------------------------------------------------------------------------------
# 5. ПРОФІЛЬ КАБІНЕТУ
# ------------------------------------------------------------------------------

@app.route("/api/patient/me", methods=["GET"])
def get_patient_profile():
    """Локальний профіль кабінету. Дані з ЕСОЗ — через /api/ehealth/person*."""
    session = _current_session()
    if not session:
        return jsonify({"error": "Потрібна авторизація"}), 401
    return jsonify({"data": {
        "local_user_id": str(session["id"]),
        "ehealth_person_id": str(session["ehealth_person_id"]) if session.get("ehealth_person_id") else None,
        "first_name": session.get("first_name") or "",
        "last_name": session.get("last_name") or "",
        "second_name": session.get("second_name") or "",
        "birth_date": str(session.get("birth_date") or ""),
        "gender": session.get("gender") or "",
        "phone": session.get("phone") if not str(session.get("phone") or "").startswith("eh") else "",
        "email": session.get("email") or "",
        "auth_provider": session.get("auth_provider", "LOCAL"),
        "ehealth_connected": bool(session.get("ehealth_access_token")),
    }}), 200


# ------------------------------------------------------------------------------
# 6. ДАНІ ЕСОЗ (PIS API). Відповіді ЕСОЗ віддаються повністю (data, paging, urgent),
#    щоб інтерфейс міг показати і обов'язкові, і всі інші атрибути.
# ------------------------------------------------------------------------------

# 3.9 Запис про пацієнта
@app.route("/api/ehealth/person", methods=["GET"])
@ehealth_route
def eh_person(token):
    result = ehealth.get_person(token)
    # п.3.9.3.8: загальний статус пацієнта (verification.verification_status) не відображається в інтерфейсі ПІС;
    # статуси за напрямами — з /api/ehealth/person/verification за правилами п.3.9.3
    if isinstance(result.get("data"), dict):
        result["data"].pop("verification", None)
    return result


@app.route("/api/ehealth/person/verification", methods=["GET"])
@ehealth_route
def eh_person_verification(token):
    """Сирі дані ЕСОЗ (усі атрибути) + display за правилами показу п.3.9.3."""
    result = ehealth.get_verification(token)
    result["display"] = verification_view(result.get("data"), _patient_age(), ehealth.config.nhsu_support_url)
    return result


@app.route("/api/ehealth/person/authentication-methods", methods=["GET"])
@ehealth_route
def eh_auth_methods(token):
    return ehealth.get_authentication_methods(token)


# 3.10.3 / 3.10.4 Методи автентифікації
@app.route("/api/ehealth/authentication-method-requests", methods=["POST"])
@ehealth_route
def eh_create_auth_method_request(token):
    data = _json()
    if not data.get("phone_number"):
        raise ValueError("Вкажіть номер телефону")
    return ehealth.create_auth_method_request(token, pis_service.normalize_phone(data["phone_number"]), data.get("alias"))


@app.route("/api/ehealth/authentication-method-requests/<request_id>/approve", methods=["PATCH"])
@ehealth_route
def eh_approve_auth_method_request(token, request_id):
    return ehealth.approve_auth_method_request(token, request_id, _json().get("verification_code"))


@app.route("/api/ehealth/authentication-method-requests/<request_id>/resend-otp", methods=["POST"])
@ehealth_route
def eh_resend_auth_method_otp(token, request_id):
    return ehealth.resend_auth_method_otp(token, request_id)


@app.route("/api/ehealth/authentication-methods/<method_id>", methods=["PATCH"])
@ehealth_route
def eh_update_auth_method(token, method_id):
    alias = (_json().get("alias") or "").strip()
    if not alias:
        raise ValueError("Вкажіть назву методу автентифікації")
    return ehealth.update_auth_method(token, method_id, alias)


@app.route("/api/ehealth/authentication-methods/<method_id>/deactivate", methods=["PATCH"])
@ehealth_route
def eh_deactivate_auth_method(token, method_id):
    return ehealth.deactivate_auth_method(token, method_id)


# 3.10.1 / 3.10.2 Зміна персональних даних
@app.route("/api/ehealth/person-requests", methods=["GET"])
@ehealth_route
def eh_list_person_requests(token):
    return ehealth.list_person_requests(token, status=request.args.get("status"),
                                        channel=request.args.get("channel"), **_paging())


@app.route("/api/ehealth/person-requests", methods=["POST"])
@ehealth_route
def eh_create_person_request(token):
    """п.3.10.1: запит на зміну даних. РНОКПП/УНЗР, внесені раніше, змінювати не можна (перевірка на сервері)."""
    data = _json()
    if not isinstance(data.get("person"), dict):
        raise ValueError("Вкажіть дані персони")
    current = ehealth.get_person(token).get("data") or {}
    errors = validate_person_update(data["person"], current)
    if errors:
        raise FieldErrors(errors)
    return ehealth.create_person_request(token, clean_person(data["person"]), False,
                                         bool(data.get("process_disclosure_data_consent", True)))


@app.route("/api/ehealth/person-requests/<request_id>", methods=["GET"])
@ehealth_route
def eh_get_person_request(token, request_id):
    return ehealth.get_person_request(token, request_id)


@app.route("/api/ehealth/person-requests/<request_id>/complete", methods=["PATCH"])
@ehealth_route
def eh_complete_person_request(token, request_id):
    return ehealth.complete_person_request(token, request_id, _signed_content())


@app.route("/api/ehealth/person-requests/<request_id>/sign-content", methods=["GET"])
@ehealth_route
def eh_person_request_sign_content(token, request_id):
    """п.3.10.1.4: дані запиту на зміну, які пацієнт підписує ЕП перед Complete."""
    details = ehealth.get_person_request(token, request_id).get("data") or {}
    if details.get("status") not in ("NEW", "APPROVED"):
        raise ValueError("Запит у цьому статусі не можна підписати")
    return {"content": person_request_sign_content(details)}


@app.route("/api/ehealth/person-requests/<request_id>/documents/upload", methods=["POST"])
@ehealth_route
def eh_upload_person_request_document(token, request_id):
    """п.3.10.1.3: копія документа для запиту на зміну; URL — лише з відповіді ЕСОЗ (п.2.4)."""
    doc_type = request.form.get("type", "")
    file = request.files.get("file")
    if not doc_type or not file:
        raise ValueError("Вкажіть тип документа і файл")
    urgent = ehealth.get_person_request(token, request_id).get("urgent") or {}
    target = next((d for d in urgent.get("documents") or [] if d.get("type") == doc_type and d.get("url")), None)
    if not target:
        raise ValueError("Для цього типу документа завантаження не очікується")
    ehealth.upload_document(target["url"], file.filename, file.read())
    return {"message": "Файл завантажено", "type": doc_type}


@app.route("/api/ehealth/person-requests/<request_id>/reject", methods=["PATCH"])
@ehealth_route
def eh_reject_person_request(token, request_id):
    return ehealth.reject_person_request(token, request_id)


def _signed_content():
    signed = _json().get("signed_content") or ""
    if not signed or not is_base64(signed):
        raise ValueError("Підписані дані мають бути в форматі BASE64")
    return signed


# 3.6 Копії документів
@app.route("/api/ehealth/documents", methods=["POST"])
@ehealth_route
def eh_init_documents(token):
    return ehealth.init_documents_upload(token)


@app.route("/api/ehealth/documents/upload", methods=["POST"])
@ehealth_route
def eh_upload_document(token):
    """
    multipart: type (тип документа з init), file.
    URL завантаження береться лише з відповіді ЕСОЗ, а не від клієнта (захист від SSRF, п.2.4).
    """
    doc_type = request.form.get("type", "")
    file = request.files.get("file")
    if not doc_type or not file:
        raise ValueError("Вкажіть тип документа і файл")
    pending = ehealth.init_documents_upload(token).get("data") or []
    target = next((d for d in pending if d.get("type") == doc_type), None)
    if not target:
        raise ValueError("Для цього типу документа завантаження не очікується")
    ehealth.upload_document(target["url"], file.filename, file.read())
    return {"message": "Файл завантажено", "type": doc_type}


@app.route("/api/ehealth/documents/complete", methods=["PATCH"])
@ehealth_route
def eh_complete_documents(token):
    return ehealth.complete_documents_upload(token)


# 3.11 Декларації
@app.route("/api/ehealth/declarations", methods=["GET"])
@ehealth_route
def eh_list_declarations(token):
    a = request.args
    return ehealth.list_declarations(token, status=a.get("status"), start_date_from=a.get("start_date_from"),
                                     start_date_to=a.get("start_date_to"), end_date_from=a.get("end_date_from"),
                                     end_date_to=a.get("end_date_to"), **_paging())


@app.route("/api/ehealth/declarations/<declaration_id>", methods=["GET"])
@ehealth_route
def eh_get_declaration(token, declaration_id):
    return ehealth.get_declaration(token, declaration_id)


@app.route("/api/ehealth/declarations/<declaration_id>/terminate", methods=["PATCH"])
@ehealth_route
def eh_terminate_declaration(token, declaration_id):
    return ehealth.terminate_declaration(token, declaration_id, (_json().get("reason_description") or "").strip() or None)


@app.route("/api/ehealth/declaration-requests", methods=["GET"])
@ehealth_route
def eh_list_declaration_requests(token):
    a = request.args
    return ehealth.list_declaration_requests(token, status=a.get("status"), channel=a.get("channel"),
                                             start_date_from=a.get("start_date_from"), start_date_to=a.get("start_date_to"),
                                             end_date_from=a.get("end_date_from"), end_date_to=a.get("end_date_to"),
                                             **_paging())


@app.route("/api/ehealth/declaration-requests", methods=["POST"])
@ehealth_route
def eh_create_declaration_request(token):
    data = _json()
    employee_id, division_id = data.get("employee_id"), data.get("division_id")
    if not employee_id or not division_id:
        raise ValueError("Оберіть лікаря і місце надання послуг")
    details = registry.doctor_details(employee_id)
    if details:
        main = next((sp.get("speciality") for sp in details["specialities"] if sp.get("speciality_officio")), None)
        if main and main not in allowed_specialities(_patient_age()):
            raise ValueError("Лікар цієї спеціальності не може обслуговувати пацієнтів вашого віку")
    return ehealth.create_declaration_request(token, {"employee_id": employee_id, "division_id": division_id})


@app.route("/api/ehealth/declaration-requests/<request_id>", methods=["GET"])
@ehealth_route
def eh_get_declaration_request(token, request_id):
    return ehealth.get_declaration_request(token, request_id)


@app.route("/api/ehealth/declaration-requests/<request_id>/sign-content", methods=["GET"])
@ehealth_route
def eh_declaration_request_sign_content(token, request_id):
    """п.3.11.1.9: дані, повернуті Системою для підпису (data_to_be_signed), з patient_signed = true."""
    details = ehealth.get_declaration_request(token, request_id).get("data") or {}
    if str(details.get("status") or "").upper() != "NEW":
        raise ValueError("Підписати можна лише запит у статусі NEW")
    signed = details.get("data_to_be_signed") or {}
    employee_id = details.get("employee_id") or (signed.get("employee") or {}).get("id")
    division_id = details.get("division_id") or (signed.get("division") or {}).get("id")
    doctor = registry.doctor_details(employee_id) if employee_id else None
    warnings = [
        # п.3.11.1.7 (і при поверненні до запиту, п.3.11.1.13.4): МНП без договору з НСЗУ
        MSG_NO_CONTRACT if division_id and registry.division_in_contract(division_id) is False else None,
        # п.3.11.1.10: попередження, якщо до ліміту лишається менше 20
        limit_warning(doctor["declarations_limit"], doctor["declarations_count"]) if doctor else None,
    ]
    return {
        "content": declaration_sign_content(details),
        "warning": "\n\n".join(w for w in warnings if w) or None,
    }


@app.route("/api/ehealth/declaration-requests/<request_id>/sign", methods=["PATCH"])
@ehealth_route
def eh_sign_declaration_request(token, request_id):
    result = ehealth.sign_declaration_request(token, request_id, _signed_content())
    data = result.get("data") or {}
    employee = data.get("employee") or {}
    party = employee.get("party") or {}
    doctor = " ".join(filter(None, [party.get("last_name"), party.get("first_name"), party.get("second_name")]))
    result["message"] = sign_result_message(data, doctor)   # п.3.11.1.11
    return result


@app.route("/api/ehealth/declaration-requests/<request_id>/reject", methods=["PATCH"])
@ehealth_route
def eh_reject_declaration_request(token, request_id):
    return ehealth.reject_declaration_request(token, request_id)


# 3.8 Доступи, надані Користувачем для ПІС
@app.route("/api/ehealth/apps", methods=["GET"])
@ehealth_route
def eh_list_apps(token):
    return ehealth.list_apps(token, page_number=request.args.get("page"), page_size=request.args.get("page_size"))


@app.route("/api/ehealth/apps/<approval_id>", methods=["GET"])
@ehealth_route
def eh_get_app(token, approval_id):
    return ehealth.get_app(token, approval_id)


@app.route("/api/ehealth/apps/<approval_id>", methods=["DELETE"])
@ehealth_route
def eh_delete_app(token, approval_id):
    ehealth.delete_app(token, approval_id)
    return None


# 3.12 Довідники та адреси: публічні дані (лише API-key), потрібні і формі реєстрації до входу
def _public_call(fn):
    try:
        return jsonify(fn()), 200
    except EhealthApiError as e:
        return _ehealth_error(e)


@app.route("/api/ehealth/dictionaries", methods=["GET"])
def eh_dictionaries():
    name = request.args.get("name")
    if name not in PUBLIC_DICTIONARIES:
        return jsonify({"error": "Невідомий довідник"}), 400
    return _public_call(lambda: registry.cached(f"dict:{name}", lambda: ehealth.dictionaries(name=name, is_active=True)))


@app.route("/api/ehealth/addresses/<kind>", methods=["GET"])
def eh_addresses(kind):
    a = request.args
    calls = {
        "regions": lambda: ehealth.address_regions(name=a.get("name")),
        "districts": lambda: ehealth.address_districts(region_id=a.get("region_id"), region=a.get("region"),
                                                       name=a.get("name")),
        # п.3.12.3.4: за районом — "Settlements by districts", інакше пошук "List of Cities By Search Params"
        "settlements": lambda: (ehealth.address_settlements_by_district(a.get("district_id"), name=a.get("name"))
                                if a.get("district_id") else
                                ehealth.address_settlements(region=a.get("region"), name=a.get("name"),
                                                            district=a.get("district"), type=a.get("type"))),
        "streets": lambda: ehealth.address_streets(settlement_id=a.get("settlement_id"), name=a.get("name"),
                                                   type=a.get("type")),
    }
    if kind not in calls:
        return jsonify({"error": "Невідомий тип адресного довідника"}), 404
    key = "addr:" + kind + ":" + "&".join(f"{k}={a.get(k)}" for k in sorted(a.keys()))
    return _public_call(lambda: registry.cached(key, calls[kind]))


# ------------------------------------------------------------------------------
# 6.1 ПОШУК ЛІКАРЯ ТА МНП ДЛЯ ДЕКЛАРАЦІЇ (локальний кеш реєстрів, п.3.11.1.2–3.11.1.5, 3.12.2)
# ------------------------------------------------------------------------------

def _patient_age():
    session = _current_session()
    return age_from_birth_date(session.get("birth_date")) if session and session.get("birth_date") else None


def _bounded_int(value, default, low, high):
    """Число з параметра запиту в межах [low, high]; некоректне значення — default."""
    try:
        return min(max(int(value), low), high)
    except (TypeError, ValueError):
        return default


def _tri(value):
    return None if value in (None, "", "any") else value in ("1", "true", "yes")


def _registry_call(fn):
    if not _current_session():
        return jsonify({"error": "Потрібна авторизація"}), 401
    return jsonify({"data": fn()}), 200


@app.route("/api/registry/doctors", methods=["GET"])
def registry_doctors():
    a = request.args
    return _registry_call(lambda: registry.search_doctors(
        patient_age=_patient_age(), name=a.get("name"), speciality=a.get("speciality") or None,
        gender=a.get("gender") or None, overlimit=_tri(a.get("overlimit")), legal_entity=a.get("legal_entity"),
        legal_entity_id=a.get("legal_entity_id"), division=a.get("division"), division_id=a.get("division_id"),
        address=a.get("address"), in_contract=_tri(a.get("in_contract")),
        limit=_bounded_int(a.get("limit"), 50, 1, 200), offset=_bounded_int(a.get("offset"), 0, 0, 100000)))


@app.route("/api/registry/doctors/<employee_id>", methods=["GET"])
def registry_doctor(employee_id):
    if not _current_session():
        return jsonify({"error": "Потрібна авторизація"}), 401
    details = registry.doctor_details(employee_id)
    if not details:
        return jsonify({"error": "Лікаря не знайдено"}), 404
    details["warning"] = limit_warning(details["declarations_limit"], details["declarations_count"])
    return jsonify({"data": details}), 200


@app.route("/api/registry/legal-entities", methods=["GET"])
def registry_legal_entities():
    return _registry_call(lambda: registry.search_legal_entities(request.args.get("name")))


@app.route("/api/registry/divisions", methods=["GET"])
def registry_divisions():
    a = request.args
    return _registry_call(lambda: registry.search_divisions(
        legal_entity_id=a.get("legal_entity_id"), name=a.get("name"), address=a.get("address")))


@app.route("/api/registry/status", methods=["GET"])
def registry_status():
    return _registry_call(lambda: registry.status())


# ------------------------------------------------------------------------------
# 7. ПРОКСІ ДО ЦСК ДЛЯ БІБЛІОТЕКИ ПІДПИСУ (КЕП у браузері, п.1.6)
# ------------------------------------------------------------------------------

@app.route("/api/kep/proxy", methods=["GET", "POST"])
def kep_proxy():
    """Запити бібліотеки ІІТ до ЦСК (сертифікати, OCSP, TSP); лише до хостів із CAs.json."""
    try:
        body = ca_proxy.forward(request.args.get("address", ""), request.args.get("contentType", ""),
                                request.method, request.get_data(cache=False), _client_ip())
    except ProxyError as e:
        logger.warning(f"KEP proxy: {e}")
        return make_response("Сервіс надавача електронних довірчих послуг недоступний", e.status)
    response = make_response(body, 200)
    response.headers["Content-Type"] = "X-user/base64-data"
    return response


# ------------------------------------------------------------------------------
# 8. СТАТИЧНИЙ ВЕБ-ІНТЕРФЕЙС
# ------------------------------------------------------------------------------

@app.route("/", methods=["GET"])
@app.route("/patient", methods=["GET"])
@app.route("/patient/", methods=["GET"])
def serve_portal():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:path>", methods=["GET"])
def serve_static(path):
    if path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    if os.path.exists(os.path.join(WEB_DIR, path)):
        return send_from_directory(WEB_DIR, path)
    # Відсутній файл (бібліотека підпису, зображення) — 404, а не сторінка кабінету: інакше перевірка
    # наявності бібліотеки КЕП (Kep.available) помилково вважає її встановленою
    if path.startswith("lib/") or os.path.splitext(path)[1]:
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(WEB_DIR, "index.html")


def start_registry_refresh():
    """Фонове оновлення кешу реєстрів (п.3.12). Викликати в одному процесі: app.py або gunicorn post_worker_init."""
    if os.getenv("PIS_REGISTRY_REFRESH", "1") != "0":
        start_background_refresh(registry, ehealth, logger=logger)


if __name__ == "__main__":
    logger.info(f"Starting SimplexMed PIS API Service on port {PORT}...")
    logger.info(f"Redirect URI configured: {ehealth.config.redirect_uri}")
    start_registry_refresh()
    app.run(host=HOST, port=PORT, debug=False)
