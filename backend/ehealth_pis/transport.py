"""HTTP-транспорт на стандартній бібліотеці. Можна підмінити (requests, httpx, тестова заглушка)."""

import ssl
import urllib.error
import urllib.request


class HttpResponse:
    def __init__(self, status, body=b"", headers=None):
        self.status = status
        self.body = body
        self.headers = headers or {}


class UrllibTransport:
    def __init__(self, ssl_context=None):
        self.ssl_context = ssl_context or ssl.create_default_context()

    def request(self, method, url, headers=None, body=None, timeout=60):
        req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(req, context=self.ssl_context, timeout=timeout) as resp:
                return HttpResponse(resp.status, resp.read(), dict(resp.headers))
        except urllib.error.HTTPError as e:
            return HttpResponse(e.code, e.read(), dict(e.headers or {}))
