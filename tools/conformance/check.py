"""
Тестова програма «Плексі»: перевірка розгорнутого екземпляра ззовні (чорна скринька), без доступу до коду.
Лише GET/HEAD/безпечні POST без змін даних. Користувацьких облікових даних не потребує.

    python pis/tools/conformance/check.py https://my-dev.simplex-med.com
    python pis/tools/conformance/check.py https://my-dev.simplex-med.com --json report.json

Перевіряє: доступність, TLS, заголовки безпеки, CORS, ознаки cookie, відсутність службових файлів,
політику конфіденційності, отримання nonce від ЕСОЗ і його формат, формування посилання авторизації,
повноту адресного довідника (постраничність), приховування розділу «Тестування», захист від перебору.
Код виходу 0 — усе пройдено, 1 — є помилки (FAIL), 2 — лише попередження (WARN).
"""
import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "PlexiConformance/1.0"


class R:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except Exception:
            return None


def http(base, path, method="GET", data=None, headers=None, timeout=30):
    req = urllib.request.Request(base + path, method=method, data=data,
                                 headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as resp:
            return R(resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read())
    except urllib.error.HTTPError as e:
        return R(e.code, {k.lower(): v for k, v in e.headers.items()}, e.read())


def post_json(base, path, obj, headers=None):
    return http(base, path, "POST", json.dumps(obj).encode(), {"Content-Type": "application/json", **(headers or {})})


results = []


def check(name, ok, detail="", level="FAIL", ref=""):
    status = "PASS" if ok else level
    results.append({"name": name, "status": status, "detail": detail, "ref": ref})
    mark = {"PASS": "ok  ", "FAIL": "FAIL", "WARN": "warn"}[status]
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not ok else ""))


def run(base):
    base = base.rstrip("/")
    t0 = time.time()
    # 1. Доступність і сторінка
    r = http(base, "/health")
    check("GET /health відповідає 200", r.status == 200, f"код {r.status}", ref="1.3")
    body = r.json() or {}
    check("/health не розкриває версії і середовище", set(body) <= {"status"}, f"поля: {sorted(body)}", "WARN", "2.3")
    r = http(base, "/", headers={"Accept": "text/html"})
    check("Головна сторінка відкривається", r.status == 200 and b"<html" in r.body.lower()[:400], f"код {r.status}")
    check("Інтерфейс українською", 'lang="uk"' in r.body.decode("utf-8", "ignore")[:600], "", "WARN", "1.5")

    # 2. Заголовки безпеки
    h = r.headers
    for name, ref in (("strict-transport-security", "2.7"), ("x-content-type-options", "2.3"), ("x-frame-options", "2.3"),
                      ("referrer-policy", "2.3"), ("content-security-policy", "2.3")):
        check(f"Заголовок {name}", name in h, "відсутній", "FAIL", ref)

    # 3. CORS: сторонній origin не отримує дозволу
    r = http(base, "/api/config", headers={"Origin": "https://evil.example"})
    check("CORS не дозволяє сторонній origin", r.headers.get("access-control-allow-origin") in (None, ""),
          f"ACAO={r.headers.get('access-control-allow-origin')}", ref="2.3")

    # 4. Службові файли не віддаються
    leaked = []
    for p in ("/.env", "/.git/config", "/backend/app.py", "/pis_service.py", "/registry.sqlite3", "/tester_data/scenarios.json"):
        rr = http(base, p, headers={"Accept": "text/html"})
        if rr.status == 200 and not rr.body.lstrip().lower().startswith((b"<!doctype", b"<html")):
            leaked.append(p)
    check("Службові файли недоступні", not leaked, ", ".join(leaked), ref="2.5")

    # 5. Політика конфіденційності
    r = http(base, "/api/privacy-policy")
    text = r.body.decode("utf-8", "ignore")
    check("Політика конфіденційності доступна", r.status == 200 and "ПОЛІТИКА" in text.upper(), f"код {r.status}", ref="3.3.1")
    r = http(base, "/api/privacy-policy?download=1")
    check("Політику можна зберегти як текстовий файл", "attachment" in r.headers.get("content-disposition", "").lower(), "", ref="3.3.1.1")

    # 6. Вхід: nonce від ЕСОЗ і посилання авторизації
    r = post_json(base, "/api/auth/nonce", {})
    nb = r.json() or {}
    check("Nonce від ЕСОЗ отримується", r.status == 200 and bool(nb.get("nonce")), f"код {r.status}", ref="3.3.2")
    content = nb.get("content") or ""
    try:
        parsed = json.loads(content)
        ok = parsed.get("jwt") == nb.get("nonce")
    except Exception:
        ok = False
    check("Вміст для підпису — JSON {\"jwt\": nonce}", ok, content[:60], ref="3.3.3")
    check("Nonce має формат JWT", re.fullmatch(r"[\w-]+\.[\w-]+\.[\w-]*", nb.get("nonce", "")) is not None, "", "WARN")
    r = post_json(base, "/api/auth-url", {"env": "my-dev", "mode": "sign-in"})
    url = (r.json() or {}).get("url", "")
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    check("Посилання авторизації містить client_id, redirect_uri, scope, state",
          all(k in q for k in ("client_id", "redirect_uri", "scope", "state")), url[:80], ref="3.3.4")
    check("Скоупи лише *_pis", all(s.endswith("_pis") for s in (q.get("scope") or [""])[0].split()), "", ref="1.4.3")
    check("Посилання вказує на сервіс авторизації ЕСОЗ", urllib.parse.urlparse(url).netloc.endswith("ehealth.gov.ua"),
          urllib.parse.urlparse(url).netloc, ref="3.3.4")

    # 7. Довідник адрес повний (постраничність)
    r = http(base, "/api/ehealth/addresses/regions")
    regions = (r.json() or {}).get("data") or []
    check("Адресний довідник повний (≥ 27 областей і міст зі спецстатусом)", len(regions) >= 27, f"отримано {len(regions)}", ref="3.12.3")

    # 8. Без сесії дані недоступні
    for p in ("/api/patient/me", "/api/ehealth/person", "/api/ehealth/declarations"):
        r = http(base, p)
        check(f"{p} без сесії → 401", r.status == 401, f"код {r.status}", ref="2.8")

    # 9. Розділ «Тестування» прихований
    r = http(base, "/api/tester/content")
    check("Розділ «Тестування» без сесії → 404", r.status in (401, 404), f"код {r.status}", "WARN")

    # 10. Захист від перебору (на неіснуючий логін, без зміни даних)
    codes = []
    for _ in range(8):
        codes.append(post_json(base, "/api/auth/local/login", {"identifier": "conformance@invalid.test", "password": "x" * 12}).status)
    check("Є обмеження частоти спроб входу (429 або вимкнено локальні акаунти)", 429 in codes or set(codes) <= {404, 400, 403, 501},
          f"коди {sorted(set(codes))}", "WARN", "2.x")

    # 11. Невідомий шлях — 404, а не службова помилка
    r = http(base, "/api/no-such-endpoint")
    check("Невідомий API-шлях → 404 JSON", r.status == 404 and r.json() is not None, f"код {r.status}")

    failed = [x for x in results if x["status"] == "FAIL"]
    warned = [x for x in results if x["status"] == "WARN"]
    print(f"\nПідсумок: {len(results) - len(failed) - len(warned)} пройдено, {len(warned)} попереджень, {len(failed)} помилок "
          f"({time.time() - t0:.1f} с) — {base}")
    return 1 if failed else (2 if warned else 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base_url")
    ap.add_argument("--json", help="зберегти звіт у файл")
    a = ap.parse_args()
    code = run(a.base_url)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"base_url": a.base_url, "results": results}, f, ensure_ascii=False, indent=1)
    return code


if __name__ == "__main__":
    sys.exit(main())
