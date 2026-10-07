"""Фаза 1: проксі ЦСК, реєстрація (п.3.5.4), підписаний вхід і реєстрація через ЕСОЗ."""

import base64
import json
import os
import sys
import urllib.parse
from datetime import date

import pytest

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)
os.environ.update({"PIS_CLIENT_ID": "CID", "PIS_CLIENT_SECRET": "SECRET"})

import app as A  # noqa: E402
from ca_proxy import CaProxy, ProxyError, split_address  # noqa: E402
from ehealth_pis.registration import sign_up_content, validate_person_request  # noqa: E402
from ehealth_pis.transport import HttpResponse  # noqa: E402

TODAY = date(2026, 10, 3)


def valid_person():
    return {
        "first_name": "Іван", "last_name": "Петренко", "second_name": "Іванович",
        "birth_date": "1985-04-12", "birth_country": "Україна", "birth_settlement": "Київ",
        "gender": "MALE", "email": "ivan@example.com", "no_tax_id": False, "tax_id": "3124509876",
        "secret": "Кодове1", "unzr": "19850412-01234",
        "documents": [{"type": "PASSPORT", "number": "АА123456", "issued_at": "2005-05-01",
                       "issued_by": "Київським РВ"}],
        "addresses": [{"type": "RESIDENCE", "country": "UA", "area": "М.КИЇВ", "settlement": "Київ",
                       "settlement_type": "CITY", "settlement_id": "b075f148-7f93-4fc2-b2ec-2d81b19a9b7b",
                       "street_type": "STREET", "street": "Хрещатик", "building": "1"}],
        "phones": [{"type": "MOBILE", "number": "+380671112233"}],
        "authentication_methods": [{"type": "OTP", "phone_number": "+380671112233"}],
        "preferred_way_communication": "phone",
        "emergency_contact": {"first_name": "Олена", "last_name": "Петренко",
                              "phones": [{"type": "MOBILE", "number": "+380671112244"}]},
    }


# ---------------------------------------------------------------- реєстрація

def test_valid_person_has_no_errors():
    assert validate_person_request(valid_person(), TODAY) == []


@pytest.mark.parametrize("mutate, field", [
    (lambda p: p.update(tax_id="123"), "tax_id"),
    (lambda p: p.update(no_tax_id=True), "tax_id"),               # відмова і РНОКПП разом
    (lambda p: p.update(secret="12"), "secret"),
    (lambda p: p.update(unzr="1985-0412"), "unzr"),
    (lambda p: p.update(gender="X"), "gender"),
    (lambda p: p.update(birth_date="2015-01-01"), "birth_date"),  # молодше 14 років
    (lambda p: p["documents"][0].update(issued_at="1980-01-01"), "documents[0].issued_at"),
    (lambda p: p.update(addresses=[]), "addresses"),
    (lambda p: p["addresses"][0].pop("settlement_id"), "addresses[0].settlement_id"),
    (lambda p: p.update(authentication_methods=[{"type": "OTP", "phone_number": "0671112233"}]),
     "authentication_methods"),
    (lambda p: p.update(preferred_way_communication="email", email=None), "email"),
    (lambda p: p["emergency_contact"].update(phones=[]), "emergency_contact.phones"),
])
def test_invalid_person_fields(mutate, field):
    person = valid_person()
    mutate(person)
    assert field in [f for f, _ in validate_person_request(person, TODAY)]


def test_foreign_birth_certificate_is_identity_document():
    # ТВ ПІС v2 (наказ № 978) п.3.4.5.9.a ix: свідоцтво про народження, видане за кордоном
    person = valid_person()
    person["documents"] = [{"type": "BIRTH_CERTIFICATE_FOREIGN", "number": "A-1234567", "issued_at": "1985-05-01",
                            "issued_by": "Посольство"}]
    assert validate_person_request(person, TODAY) == []


def test_minor_needs_legal_capacity_document():
    person = valid_person()
    person["birth_date"] = "2010-01-01"   # 16 років
    person["documents"][0]["issued_at"] = "2024-01-01"
    assert "documents" in [f for f, _ in validate_person_request(person, TODAY)]


def test_sign_up_content_format():
    content = json.loads(sign_up_content({"first_name": "Іван"}, "NONCE"))
    assert content == {"person": {"first_name": "Іван"}, "patient_signed": True,
                       "process_disclosure_data_consent": True, "jwt": "NONCE"}


# ---------------------------------------------------------------- проксі ЦСК

class FakeResp:
    def __init__(self, status=200, body=b"OCSP-RESPONSE"):
        self.status, self.body = status, body

    def read(self, n=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    def __init__(self):
        self.requests = []

    def open(self, req, timeout=None):
        self.requests.append(req)
        return FakeResp()


@pytest.fixture
def proxy(tmp_path):
    cas = tmp_path / "CAs.json"
    cas.write_text(json.dumps([{"issuerCNs": ["КНЕДП ДПС"], "address": "ca.tax.gov.ua",
                                "ocspAccessPointAddress": "ca.tax.gov.ua/services/ocsp/",
                                "tspAddress": "acskidd.gov.ua"}]), encoding="utf-8")
    opener = FakeOpener()
    return CaProxy(str(cas), opener=opener), opener


def test_split_address():
    assert split_address("ca.tax.gov.ua/services/ocsp/") == ("ca.tax.gov.ua", "http://ca.tax.gov.ua/services/ocsp/")
    assert split_address("ftp://ca.tax.gov.ua")[0] == ""
    assert split_address("http://user:pw@ca.tax.gov.ua")[0] == ""


def test_proxy_forwards_only_to_ca_hosts(proxy):
    p, opener = proxy
    out = p.forward("ca.tax.gov.ua/services/ocsp/", "application/ocsp-request", "POST",
                    base64.b64encode(b"REQ"), "1.1.1.1")
    assert base64.b64decode(out) == b"OCSP-RESPONSE"
    assert opener.requests[0].full_url == "http://ca.tax.gov.ua/services/ocsp/"
    assert opener.requests[0].data == b"REQ"
    for bad in ("169.254.169.254/latest", "localhost:3122/api", "ca.tax.gov.ua.evil.com/", "evil.com"):
        with pytest.raises(ProxyError) as e:
            p.forward(bad, "", "GET", b"", "1.1.1.1")
        assert e.value.status == 403


def test_proxy_rate_limit(proxy, monkeypatch):
    p, _ = proxy
    monkeypatch.setattr("ca_proxy.RATE_LIMIT_PER_MINUTE", 3)
    for _ in range(3):
        p.forward("ca.tax.gov.ua", "", "GET", b"", "2.2.2.2")
    with pytest.raises(ProxyError) as e:
        p.forward("ca.tax.gov.ua", "", "GET", b"", "2.2.2.2")
    assert e.value.status == 429


def test_proxy_route(proxy, monkeypatch):
    p, _ = proxy
    monkeypatch.setattr(A, "ca_proxy", p)
    c = A.app.test_client()
    r = c.post("/api/kep/proxy?address=ca.tax.gov.ua/services/ocsp/&contentType=application/ocsp-request",
               data=base64.b64encode(b"REQ"), headers={"Content-Type": "X-user/base64-data"})
    assert r.status_code == 200 and r.headers["Content-Type"] == "X-user/base64-data"
    assert base64.b64decode(r.data) == b"OCSP-RESPONSE"
    assert c.get("/api/kep/proxy?address=169.254.169.254/").status_code == 403


# ---------------------------------------------------------------- маршрути входу/реєстрації

class Stub:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def request(self, method, url, headers=None, body=None, timeout=60):
        path = urllib.parse.urlparse(url).path
        self.calls.append((method, path))
        status, payload = self.routes.get((method, path), (404, {"error": {"message": "nf"}}))
        return HttpResponse(status, json.dumps(payload).encode())


@pytest.fixture
def client(monkeypatch):
    stub = Stub({("POST", "/oauth/nonce"): (200, {"data": {"token": "NONCE-JWT"}})})
    monkeypatch.setattr(A.ehealth, "transport", stub)
    return A.app.test_client(), stub


def test_sign_up_prepare_validates_and_returns_content(client):
    c, stub = client
    bad = valid_person()
    bad["tax_id"] = "1"
    r = c.post("/api/auth/sign-up/prepare", json={"person": bad})
    assert r.status_code == 422 and r.get_json()["fields"][0]["field"] == "tax_id"
    assert stub.calls == []   # nonce не запитуємо для некоректних даних
    r = c.post("/api/auth/sign-up/prepare", json={"person": valid_person()})
    content = json.loads(r.get_json()["content"])
    assert content["jwt"] == "NONCE-JWT" and content["patient_signed"] is True
    assert content["person"]["tax_id"] == "3124509876"


def test_sign_up_url_requires_signed_user_data(client):
    c, _ = client
    assert c.post("/api/auth-url", json={"env": "my-dev", "mode": "sign-up"}).status_code == 400
    r = c.post("/api/auth-url", json={"env": "my-dev", "mode": "sign-up", "user_data": "U0lHTkVE"})
    url = urllib.parse.urlparse(r.get_json()["url"])
    q = urllib.parse.parse_qs(url.query)
    assert url.path == "/sign-up" and q["user_data"] == ["U0lHTkVE"]
    assert q["state"][0].startswith("my-dev|/|")
    assert c.get_cookie("pis_oauth_state") is not None


def test_signed_sign_in_url(client):
    c, _ = client
    r = c.post("/api/auth-url", json={"env": "my", "user_data": "U0lHTkVE"})
    url = urllib.parse.urlparse(r.get_json()["url"])
    assert url.path == "/sign-in" and urllib.parse.parse_qs(url.query)["user_data"] == ["U0lHTkVE"]


def test_public_dictionaries_whitelist(client):
    c, stub = client
    stub.routes[("GET", "/api/v2/dictionaries")] = (200, {"data": [{"name": "COUNTRY", "values": []}]})
    assert c.get("/api/ehealth/dictionaries?name=COUNTRY").status_code == 200
    assert c.get("/api/ehealth/dictionaries?name=SOMETHING_ELSE").status_code == 400


def test_library_files_cached(client):
    c, _ = client
    r = c.get("/lib/euscp/euscp.js")
    if r.status_code == 200:  # файли бібліотеки є лише після fetch_euscp.py
        assert "max-age" in r.headers["Cache-Control"]


def test_blocked_email_domains():
    from ehealth_pis.registration import email_domain_blocked
    assert email_domain_blocked("a@yandex.ua") and email_domain_blocked("a@MAIL.RU")
    assert email_domain_blocked("a@mail.yandex.ua") and email_domain_blocked("a@anything.ru")
    assert not email_domain_blocked("a@ukr.net") and not email_domain_blocked("a@gmail.com")
    assert not email_domain_blocked("a@i.ua")
