"""
Клієнт eHealth PIS API (кваліфікована ПІС, КПІС).

Специфікація: pis/docs/ehealth-pis-api.apib (github.com/ehealth-ua/pis-api).
Назви методів у _call() збігаються з колонкою "Метод API" Додатку 1, щоб помилки
мапились на повідомлення для користувача.

Модуль не залежить від Flask і БД: його можна перенести в інший продукт разом із
config.py, errors.py, transport.py, signing.py та annex1_errors.json.
"""

import gzip
import json
import os
import time
import urllib.parse
from dataclasses import dataclass, field

from .config import PisConfig
from .errors import Annex1, EhealthApiError, NETWORK_MESSAGE
from .transport import UrllibTransport

DOCUMENT_EXTENSIONS = {".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                       ".png": "image/png", ".bmp": "image/bmp"}
DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
GZIP_MAGIC = bytes([0x1F, 0x8B])
DOCUMENT_FORBIDDEN_CHARS = set("ЫЪЭЁыъэё@%&$^#")


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str
    expires_at: int            # unix timestamp
    person_id: str = ""
    user_id: str = ""
    scope: str = ""
    raw: dict = field(default_factory=dict, repr=False)

    def expires_within(self, seconds):
        return self.expires_at - time.time() <= seconds

    @classmethod
    def from_response(cls, data, previous_refresh_token=""):
        details = data.get("details") or {}
        return cls(
            access_token=data.get("value", ""),
            # при оновленні за refresh_token новий refresh_token не видається
            refresh_token=details.get("refresh_token") or previous_refresh_token,
            expires_at=int(data.get("expires_at") or 0),
            person_id=(data.get("user") or {}).get("person_id", ""),
            user_id=data.get("user_id", ""),
            scope=details.get("scope", ""),
            raw=data,
        )


# Сигнатури файлів: вміст має відповідати розширенню (не лише назва)
DOCUMENT_SIGNATURES = {".pdf": (b"%PDF",), ".jpg": (b"\xff\xd8\xff",), ".jpeg": (b"\xff\xd8\xff",),
                       ".png": (b"\x89PNG\r\n\x1a\n",), ".bmp": (b"BM",)}


def validate_document_file(filename, size, content=None):
    """Вимоги п.3.6.1 до файлів копій документів. Повертає текст помилки або None."""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in DOCUMENT_EXTENSIONS:
        return "Дозволені формати файлів: PDF, JPG, PNG, BMP"
    if content is not None and not any(content.startswith(sig) for sig in DOCUMENT_SIGNATURES.get(ext, (b"",))):
        return "Вміст файлу не відповідає формату PDF, JPG, PNG або BMP"
    if size > DOCUMENT_MAX_BYTES:
        return "Розмір файлу не може перевищувати 20 МБ"
    if DOCUMENT_FORBIDDEN_CHARS & set(filename):
        return "Назва файлу не може містити символи: ЫЪЭЁыъэё@%&$^#"
    return None


class PisClient:
    def __init__(self, config: PisConfig, transport=None, annex=None):
        self.config = config
        self.transport = transport or UrllibTransport()
        self.annex = annex or Annex1(pis_name=config.pis_name, support_contacts=config.support_contacts,
                                     support_url=config.nhsu_support_url)

    # ------------------------------------------------------------------
    # Транспорт
    # ------------------------------------------------------------------

    def _headers(self, token=None, json_body=True):
        headers = {
            "API-key": self.config.client_secret,
            "Accept": "application/json",
            "User-Agent": self.config.user_agent,
        }
        if json_body:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if self.config.psk:
            headers["X-Custom-PSK"] = self.config.psk
        return headers

    def _call(self, api_method, http_method, path, token=None, body=None, params=None, host=None):
        url = (host or self.config.api_host) + path
        if params:
            clean = {k: v for k, v in params.items() if v not in (None, "")}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            resp = self.transport.request(http_method, url, headers=self._headers(token),
                                          body=data, timeout=self.config.timeout)
        except Exception as e:  # мережа, таймаут, TLS
            raise EhealthApiError(api_method, 0, message=str(e), error_type="network",
                                  user_message=NETWORK_MESSAGE) from e

        payload = None
        body = resp.body
        if body[:2] == GZIP_MAGIC:  # bulk-вивантаження можуть надходити стиснутими (application/octet-stream)
            body = gzip.decompress(body)
        if body:
            try:
                payload = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                payload = {"raw": body[:2000].decode("utf-8", "replace")}
        if 200 <= resp.status < 300:
            if payload is not None and "raw" in payload and len(payload) == 1:
                # WAF може повернути HTML-сторінку блокування з кодом 200 — це не успішна відповідь
                raise EhealthApiError(api_method, 502, message=payload["raw"][:200], error_type="invalid_response",
                                      user_message=NETWORK_MESSAGE)
            return payload if payload is not None else {}

        err = (payload or {}).get("error") if isinstance(payload, dict) else None
        if isinstance(err, dict):
            message, error_type, invalid = err.get("message", ""), err.get("type", ""), err.get("invalid", [])
        else:
            message, error_type, invalid = str(err or (payload or {}).get("raw", "")), "", []
        texts = [message] + [r.get("description", "") for i in invalid for r in i.get("rules", [])]
        user_message, action = self.annex.resolve(api_method, resp.status, " ".join(t for t in texts if t), error_type)
        raise EhealthApiError(api_method, resp.status, message=message, error_type=error_type,
                              invalid=invalid, payload=payload, user_message=user_message, action=action)

    @staticmethod
    def _data(payload):
        return payload.get("data") if isinstance(payload, dict) else payload

    # ------------------------------------------------------------------
    # 3.3 / 3.5 Авторизація і реєстрація через КПІС, 3.7 припинення токенів
    # ------------------------------------------------------------------

    def get_nonce(self):
        """POST /oauth/nonce — одноразовий JWT, який користувач підписує ЕП."""
        payload = self._call("PIS. Get nonce", "POST", "/oauth/nonce",
                             body={"client_id": self.config.client_id}, host=self.config.auth_host)
        return self._data(payload)["token"]

    def _login_url(self, path, user_data=None, state=None, scopes=None):
        params = {
            "client_id": self.config.client_id,
            "redirect_uri": self.config.redirect_uri,
            "scope": " ".join(scopes) if scopes else self.config.scope_string,
        }
        if user_data:
            params["user_data"] = user_data
        if state:
            params["state"] = state
        return f"{self.config.login_host}{path}?{urllib.parse.urlencode(params)}"

    def sign_in_url(self, state, user_data=None, scopes=None):
        """URL сервісу авторизації (PIS. Patient sign-in). user_data — base64 підписаного nonce."""
        return self._login_url("/sign-in", user_data, state, scopes)

    def sign_up_url(self, user_data, state=None, scopes=None):
        """URL сервісу реєстрації (PIS. Patient sign-up). user_data — base64 підписаної форми."""
        return self._login_url("/sign-up", user_data, state, scopes)

    def confidant_sign_in_url(self, state, user_data, scopes=None):
        return self._login_url("/confidant/sign-in", user_data, state, scopes)

    def confidant_sign_up_url(self, user_data, state=None, scopes=None):
        return self._login_url("/confidant/sign-up", user_data, state, scopes)

    def exchange_code(self, code, scopes=None):
        body = {"token": {
            "grant_type": "authorization_code",
            "client_id": self.config.client_id,
            "client_secret": self.config.client_secret,
            "code": code,
            "redirect_uri": self.config.redirect_uri,
            "scope": " ".join(scopes) if scopes else self.config.scope_string,
        }}
        payload = self._call("PIS. Exchange oAuth Code Grant to Access Token", "POST", "/oauth/tokens",
                             body=body, host=self.config.auth_host)
        return TokenSet.from_response(self._data(payload))

    def refresh(self, refresh_token):
        """п.1.4.1: оновлення Access token за Refresh token."""
        body = {"token": {
            "grant_type": "refresh_token",
            "client_id": self.config.client_id,
            "client_secret": self.config.client_secret,
            "refresh_token": refresh_token,
        }}
        payload = self._call("Renew access token using refresh token", "POST", "/oauth/tokens",
                             body=body, host=self.config.auth_host)
        return TokenSet.from_response(self._data(payload), previous_refresh_token=refresh_token)

    def logout(self, access_token):
        """п.3.7: припинення дії Access token і Refresh token."""
        self._call("Logout", "POST", "/auth/logout", token=access_token, body={}, host=self.config.auth_host)

    # ------------------------------------------------------------------
    # 3.8 Доступи, надані Користувачем для ПІС (approvals / apps)
    # ------------------------------------------------------------------

    def _list_all(self, api_method, path, token, params, page_key, page_size):
        """Переліки пацієнта ЕСОЗ віддає сторінками (за замовчуванням по 50). Якщо клієнт не просить конкретну
        сторінку — збираємо всі, щоб перелік був повним (п.3.8.1, 3.10.2, 3.11.2, 3.11.3)."""
        if params.get(page_key) is not None:
            return self._call(api_method, "GET", path, token, params=params)
        data, page, result = [], 1, {}
        while page <= 40:
            result = self._call(api_method, "GET", path, token,
                                params={**params, page_key: page, "page_size": params.get("page_size") or page_size})
            data.extend(result.get("data") or [])
            if page >= int((result.get("paging") or {}).get("total_pages") or 1):
                break
            page += 1
        return {**result, "data": data}

    def list_apps(self, token, client_ids=None, client_names=None, page_number=None, page_size=None):
        return self._list_all("PIS. Get Approvals", "/api/pis/apps", token, {
            "client_ids": ",".join(client_ids) if client_ids else None,
            "client_names": ",".join(client_names) if client_names else None,
            "page_number": page_number, "page_size": page_size}, "page_number", 100)

    def get_app(self, token, approval_id):
        return self._call("PIS. Get Approval details", "GET", f"/api/pis/apps/{_q(approval_id)}", token)

    def delete_app(self, token, approval_id):
        return self._call("PIS. Delete approval", "DELETE", f"/api/pis/apps/{_q(approval_id)}", token)

    # ------------------------------------------------------------------
    # 3.6 Електронні копії документів
    # ------------------------------------------------------------------

    def init_documents_upload(self, token):
        """Повертає перелік {type, url} документів, які треба завантажити."""
        return self._call("PIS. Initialize Person documents upload", "POST", "/api/pis/documents", token, body={})

    def upload_document(self, upload_url, filename, content):
        """PUT файлу на підписаний URL сховища, отриманий з init_documents_upload."""
        error = validate_document_file(filename, len(content), content)
        if error:
            raise ValueError(error)
        content_type = DOCUMENT_EXTENSIONS[os.path.splitext(filename)[1].lower()]
        try:
            resp = self.transport.request("PUT", upload_url, headers={"Content-Type": content_type},
                                          body=content, timeout=self.config.timeout)
        except Exception as e:
            raise EhealthApiError("PIS. Initialize Person documents upload", 0, message=str(e),
                                  error_type="network", user_message=NETWORK_MESSAGE) from e
        if not 200 <= resp.status < 300:
            raise EhealthApiError("PIS. Initialize Person documents upload", resp.status,
                                  message=resp.body[:500].decode("utf-8", "replace"),
                                  user_message=self.annex.resolve("PIS. Initialize Person documents upload", resp.status)[0])

    def complete_documents_upload(self, token):
        return self._call("PIS. Complete Person documents upload", "PATCH", "/api/pis/documents/actions/complete",
                          token, body={})

    # ------------------------------------------------------------------
    # 3.9 Дані запису про пацієнта
    # ------------------------------------------------------------------

    def get_person(self, token):
        return self._call("PIS. Get Person details", "GET", "/api/pis/person", token)

    def get_authentication_methods(self, token):
        return self._call("PIS. Get Person authentication methods", "GET", "/api/pis/person/authentication_methods", token)

    def get_verification(self, token):
        return self._call("PIS. Get Person verification details", "GET", "/api/pis/person/verification", token)

    # ------------------------------------------------------------------
    # 3.10.3 / 3.10.4 Методи автентифікації
    # ------------------------------------------------------------------

    def create_auth_method_request(self, token, phone_number, alias=None):
        method = {"type": "OTP", "phone_number": phone_number}
        if alias:
            method["alias"] = alias
        return self._call("PIS. Create authentication method request", "POST",
                          "/api/pis/authentication_method_requests", token, body={"authentication_method": method})

    def approve_auth_method_request(self, token, request_id, verification_code=None):
        # Код — рядок цифр: початкові нулі значущі ("0123" не можна перетворювати на 123)
        code = str(verification_code).strip() if verification_code not in (None, "") else ""
        body = {"verification_code": int(code) if code and not code.startswith("0") else code} if code else {}
        return self._call("PIS. Approve authentication method request", "PATCH",
                          f"/api/pis/authentication_method_requests/{_q(request_id)}/actions/approve", token, body=body)

    def resend_auth_method_otp(self, token, request_id):
        return self._call("PIS. Resend authorization OTP for authentication method request", "POST",
                          f"/api/pis/authentication_method_requests/{_q(request_id)}/actions/resend_otp", token, body={})

    def deactivate_auth_method(self, token, method_id):
        return self._call("PIS. Deactivate authentication method", "PATCH",
                          f"/api/pis/authentication_methods/{_q(method_id)}/actions/deactivate", token, body={})

    def update_auth_method(self, token, method_id, alias):
        return self._call("PIS. Update authentication method", "PATCH",
                          f"/api/pis/authentication_methods/{_q(method_id)}", token, body={"alias": alias})

    # ------------------------------------------------------------------
    # 3.10.1 / 3.10.2 Зміна персональних даних (person requests)
    # ------------------------------------------------------------------

    def create_person_request(self, token, person, patient_signed=False, process_disclosure_data_consent=True):
        body = {"person": person, "patient_signed": patient_signed,
                "process_disclosure_data_consent": process_disclosure_data_consent}
        return self._call("PIS. Initialize Update Person details", "POST", "/api/pis/person_requests", token, body=body)

    def complete_person_request(self, token, request_id, signed_content):
        body = {"signed_content": signed_content, "signed_content_encoding": "base64"}
        return self._call("PIS. Complete Update Person details", "PATCH",
                          f"/api/pis/person_requests/{_q(request_id)}/actions/complete", token, body=body)

    def list_person_requests(self, token, status=None, channel=None, page=None, page_size=None):
        return self._list_all("PIS. Get Person Requests List", "/api/pis/person_requests", token,
                              {"status": status, "channel": channel, "page": page, "page_size": page_size}, "page", 300)

    def get_person_request(self, token, request_id):
        return self._call("PIS. Get Person Request Details", "GET", f"/api/pis/person_requests/{_q(request_id)}", token)

    def reject_person_request(self, token, request_id):
        return self._call("PIS. Reject Person Request", "PATCH",
                          f"/api/pis/person_requests/{_q(request_id)}/actions/reject", token, body={})

    # ------------------------------------------------------------------
    # 3.11 Декларації та запити на декларацію
    # ------------------------------------------------------------------

    def list_declarations(self, token, status=None, start_date_from=None, start_date_to=None,
                          end_date_from=None, end_date_to=None, page=None, page_size=None):
        return self._list_all("PIS. Get declarations", "/api/pis/declarations", token, {
            "status": status, "start_date_from": start_date_from, "start_date_to": start_date_to,
            "end_date_from": end_date_from, "end_date_to": end_date_to, "page": page, "page_size": page_size}, "page", 300)

    def get_declaration(self, token, declaration_id):
        return self._call("PIS. Get Declaration details", "GET", f"/api/pis/declarations/{_q(declaration_id)}", token)

    def terminate_declaration(self, token, declaration_id, reason_description=None):
        body = {"reason_description": reason_description} if reason_description else {}
        return self._call("PIS. Terminate declaration", "PATCH",
                          f"/api/pis/declarations/{_q(declaration_id)}/actions/terminate", token, body=body)

    def list_declaration_requests(self, token, status=None, channel=None, start_date_from=None, start_date_to=None,
                                  end_date_from=None, end_date_to=None, page=None, page_size=None):
        return self._list_all("PIS. Get Declaration requests", "/api/pis/declaration_requests", token, {
            "status": status, "channel": channel, "start_date_from": start_date_from,
            "start_date_to": start_date_to, "end_date_from": end_date_from, "end_date_to": end_date_to,
            "page": page, "page_size": page_size}, "page", 300)

    def get_declaration_request(self, token, request_id):
        return self._call("PIS. Get Declaration request details", "GET",
                          f"/api/pis/declaration_requests/{_q(request_id)}", token)

    def create_declaration_request(self, token, declaration_request):
        return self._call("PIS. Create Declaration request", "POST", "/api/pis/declaration_requests", token,
                          body=declaration_request)

    def sign_declaration_request(self, token, request_id, signed_content):
        body = {"signed_content": signed_content, "signed_content_encoding": "base64"}
        return self._call("PIS. Sign Declaration request", "PATCH",
                          f"/api/pis/declaration_requests/{_q(request_id)}/actions/sign", token, body=body)

    def reject_declaration_request(self, token, request_id):
        return self._call("PIS. Reject Declaration request", "PATCH",
                          f"/api/pis/declaration_requests/{_q(request_id)}/actions/reject", token, body={})

    # ------------------------------------------------------------------
    # 3.12 Переліки з реєстрів (bulk, лише API-key), адреси, довідники
    # ------------------------------------------------------------------

    def _bulk(self, api_method, resource, depth=None):
        return self._call(api_method, "GET", f"/api/pis/bulk/{resource}", params={"depth": depth})

    def bulk_parties(self, depth=None):
        return self._bulk("PIS. Get parties (Bulk data export)", "parties", depth)

    def bulk_employees(self, depth=None):
        return self._bulk("PIS. Get employees (Bulk data export)", "employees", depth)

    def bulk_divisions(self, depth=None):
        return self._bulk("PIS. Get divisions (Bulk data export)", "divisions", depth)

    def bulk_legal_entities(self, depth=None):
        return self._bulk("PIS. Get legal entities (Bulk data export)", "legal_entities", depth)

    def bulk_employee_roles(self, depth=None):
        return self._bulk("PIS. Get employee roles (Bulk data export)", "employee_roles", depth)

    def bulk_healthcare_services(self, depth=None):
        return self._bulk("PIS. Get healthcare services (Bulk data export)", "healthcare_services", depth)

    def bulk_contract_divisions(self, depth=None):
        return self._bulk("PIS. Contract Divisions (Bulk data export)", "contract_divisions", depth)

    def bulk_declarations_limit(self):
        return self._bulk("PIS. Get declarations limit and declarations count per practitioner (Bulk data export)",
                          "declarations_limit")

    def _all_pages(self, api_method, path, params=None, max_pages=30, page_size=100):
        """Адресні переліки ЕСОЗ віддаються сторінками (за замовчуванням по 10): збираємо всі сторінки."""
        data, page, result = [], 1, {}
        while page <= max_pages:
            result = self._call(api_method, "GET", path, params={**(params or {}), "page": page, "page_size": page_size})
            data.extend(result.get("data") or [])
            paging = result.get("paging") or {}
            if page >= int(paging.get("total_pages") or 1):
                break
            page += 1
        return {**result, "data": data}

    def address_regions(self, name=None, koatuu=None):
        return self._all_pages("Get regions", "/api/uaddresses/regions", {"name": name, "koatuu": koatuu})

    def address_districts(self, region_id=None, region=None, name=None, koatuu=None):
        """п.3.12.3.3: райони області — метод "Districts by Region" (за ідентифікатором області)."""
        if region_id:
            return self._all_pages("Districts by Region",
                                   f"/api/uaddresses/regions/{urllib.parse.quote(str(region_id), safe='')}/districts",
                                   {"name": name, "koatuu": koatuu})
        return self._all_pages("Get districts", "/api/uaddresses/districts",
                               {"region": region, "name": name, "koatuu": koatuu})

    def address_settlements_by_district(self, district_id, name=None, koatuu=None):
        """п.3.12.3.4.1: населені пункти району — метод "Settlements by districts"."""
        return self._all_pages("Settlements by districts",
                               f"/api/uaddresses/districts/{urllib.parse.quote(str(district_id), safe='')}/settlements",
                               {"name": name, "koatuu": koatuu})

    def address_settlements(self, region, name=None, district=None, koatuu=None, mountain_group=None, type=None):
        return self._call("Get settlements", "GET", "/api/uaddresses/settlements", params={
            "region": region, "name": name, "district": district, "koatuu": koatuu,
            "mountain_group": mountain_group, "type": type, "page_size": 100})

    def address_streets(self, settlement_id, name=None, type=None):
        return self._call("Get streets", "GET", "/api/uaddresses/streets",
                          params={"settlement_id": settlement_id, "name": name, "type": type, "page_size": 100})

    def dictionaries(self, name=None, is_active=None, value_code=None, value_description=None, value_is_active=None):
        return self._call("Get dictionaries", "GET", "/api/v2/dictionaries", params={
            "name": name, "is_active": _bool(is_active), "value_code": value_code,
            "value_description": value_description, "value_is_active": _bool(value_is_active)})

    def get_event(self, event_id):
        return self._call("Get events by ID", "GET", f"/api/events/{_q(event_id)}")

    def list_events(self, date=None, date_to=None, event_type=None, entity_type=None, attribute_name=None,
                    new_value=None, page=None, page_size=None):
        return self._call("Get events list", "GET", "/api/events", params={
            "date": date, "date_to": date_to, "event_type": event_type, "entity_type": entity_type,
            "attribute_name": attribute_name, "new_value": new_value, "page": page, "page_size": page_size})


def _q(value):
    """Ідентифікатор у шляху URL: лише безпечні символи, без можливості змінити шлях."""
    return urllib.parse.quote(str(value), safe="")


def _bool(value):
    return None if value is None else ("true" if value else "false")
