"""
HTTP-проксі до ЦСК для браузерної бібліотеки підпису ІІТ (EndUser, euscp).

Бібліотека у браузері не може звертатися до серверів ЦСК (CMP, OCSP, TSP) напряму
через CORS (крім ЦСК із directAccess) і шле запити сюди:

    POST /api/kep/proxy?address=<хост[:порт]/шлях>&contentType=<тип>
    Content-Type: X-user/base64-data
    <base64 тіла запиту>

і чекає у відповідь base64 тіла відповіді ЦСК. Ключ і пароль сюди не потрапляють:
через проксі йдуть лише запити сертифікатів, статусів і позначок часу.

Щоб маршрут не став відкритим проксі (SSRF, п.2.4 ТВ ПІС), адреса пропускається лише
до хостів із переліку ЦСК (CAs.json), лише http/https, без редиректів, з обмеженням
розміру і частоти запитів.
"""

import base64
import binascii
import json
import os
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

CA_ADDRESS_KEYS = ("address", "cmpAddress", "tspAddress", "ocspAccessPointAddress")
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
TIMEOUT_SECONDS = 20
RATE_LIMIT_PER_MINUTE = 240


class ProxyError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def split_address(address):
    """('ca.tax.gov.ua/services/ocsp/') -> (host, url). Порожній host — адреса непридатна."""
    address = (address or "").strip()
    if not address:
        return "", ""
    url = address if "://" in address else f"http://{address}"
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 — ValueError на некоректному порту
    except ValueError:
        return "", ""
    if parts.scheme not in ("http", "https") or parts.username or parts.password:
        return "", ""
    if parts.port not in (None, 80, 443):  # у CAs.json лише стандартні порти — інші не проксіюємо
        return "", ""
    return (parts.hostname or "").lower(), url


class CaProxy:
    def __init__(self, cas_json_path, opener=None):
        self.cas_json_path = cas_json_path
        self._hosts_cache = (None, frozenset())
        self._opener = opener or urllib.request.build_opener(_NoRedirect)
        self._hits = {}
        self._lock = threading.Lock()

    def allowed_hosts(self):
        """Хости ЦСК зі списку бібліотеки; перечитуються, коли файл оновили."""
        try:
            mtime = os.path.getmtime(self.cas_json_path)
        except OSError:
            return frozenset()
        if self._hosts_cache[0] != mtime:
            with open(self.cas_json_path, encoding="utf-8-sig") as f:
                cas = json.load(f)
            hosts = frozenset(host for ca in cas for key in CA_ADDRESS_KEYS
                              for host in [split_address(ca.get(key))[0]] if host)
            self._hosts_cache = (mtime, hosts)
        return self._hosts_cache[1]

    def _rate_limited(self, client_id):
        now = time.monotonic()
        with self._lock:
            hits = [t for t in self._hits.get(client_id, []) if now - t < 60]
            hits.append(now)
            self._hits[client_id] = hits
            if len(self._hits) > 10000:  # не тримати пам'ять під довільні IP
                self._hits = {k: v for k, v in self._hits.items() if now - v[-1] < 60}
            return len(hits) > RATE_LIMIT_PER_MINUTE

    def forward(self, address, content_type, method, body_b64, client_id=""):
        """Повертає base64 відповіді ЦСК або кидає ProxyError."""
        if self._rate_limited(client_id):
            raise ProxyError(429, "Too many requests")
        host, url = split_address(address)
        if not host or host not in self.allowed_hosts():
            raise ProxyError(403, "Address not allowed")
        data = None
        if method == "POST":
            try:
                data = base64.b64decode(body_b64 or b"", validate=False)
            except (binascii.Error, ValueError):
                raise ProxyError(400, "Bad request body")
            if len(data) > MAX_REQUEST_BYTES:
                raise ProxyError(413, "Request too large")
        headers = {"Content-Type": content_type} if content_type else {}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=TIMEOUT_SECONDS) as resp:
                if resp.status != 200:
                    raise ProxyError(502, "CA error")
                content = resp.read(MAX_RESPONSE_BYTES + 1)
        except (urllib.error.URLError, OSError) as e:
            raise ProxyError(502, f"CA unavailable: {e}")
        if len(content) > MAX_RESPONSE_BYTES:
            raise ProxyError(502, "CA response too large")
        return base64.b64encode(content)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
