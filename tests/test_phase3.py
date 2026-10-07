"""Фаза 3: декларації (п.3.11) через BFF з кешем реєстрів (п.3.12)."""

import json
import os
import sys
import urllib.parse
from datetime import date, datetime, timedelta, timezone

import pytest

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update({"PIS_CLIENT_ID": "CID", "PIS_CLIENT_SECRET": "SECRET"})

import app as A  # noqa: E402
import pis_service as ps  # noqa: E402
from ehealth_pis.declarations import (MSG_APPROVED, declaration_sign_content, limit_warning,  # noqa: E402
                                      sign_result_message)
from ehealth_pis.registry import RegistryStore  # noqa: E402
from ehealth_pis.transport import HttpResponse  # noqa: E402
from test_registry import FakeClient  # noqa: E402


class Router:
    def __init__(self):
        self.routes, self.calls = {}, []

    def on(self, method, path, status, body):
        self.routes[(method, path)] = (status, body)

    def request(self, method, url, headers=None, body=None, timeout=60):
        path = urllib.parse.urlparse(url).path
        self.calls.append((method, path, body))
        status, payload = self.routes.get((method, path), (404, {"error": {"message": "nf"}}))
        return HttpResponse(status, json.dumps(payload).encode())


@pytest.fixture
def env(monkeypatch, tmp_path):
    store = RegistryStore(str(tmp_path / "r.sqlite3"))
    store.refresh_due(FakeClient())
    monkeypatch.setattr(A, "registry", store)
    router = Router()
    monkeypatch.setattr(A.ehealth, "transport", router)
    sessions = {"T1": {"session_id": "S1", "id": "U1", "birth_date": date(1990, 1, 1), "ehealth_person_id": "P1",
                       "ehealth_access_token": "AT", "ehealth_refresh_token": "RT",
                       "ehealth_expires_at": datetime.now(timezone.utc) + timedelta(hours=1)},
                "CHILD": {"session_id": "S2", "id": "U2", "birth_date": date(2016, 5, 1), "ehealth_person_id": "P2",
                          "ehealth_access_token": "AT2", "ehealth_refresh_token": "RT2",
                          "ehealth_expires_at": datetime.now(timezone.utc) + timedelta(hours=1)}}
    monkeypatch.setattr(ps, "get_session", lambda t: dict(sessions[t]) if t in sessions else None)
    c = A.app.test_client()
    c.set_cookie("pis_session_token", "T1")
    return c, router


def names(r):
    return sorted(d["last_name"] for d in r.get_json()["data"])


def test_registry_search_uses_patient_age(env):
    c, _ = env
    assert names(c.get("/api/registry/doctors")) == ["Бондар", "Коваль"]
    c.set_cookie("pis_session_token", "CHILD")
    assert names(c.get("/api/registry/doctors")) == ["Коваль", "Шевченко"]


def test_registry_filters_via_api(env):
    c, _ = env
    assert names(c.get("/api/registry/doctors?in_contract=true")) == ["Коваль"]
    assert names(c.get("/api/registry/doctors?overlimit=true")) == ["Бондар"]
    assert names(c.get("/api/registry/doctors?address=" + urllib.parse.quote("Львів"))) == ["Бондар"]
    divisions = c.get("/api/registry/divisions?legal_entity_id=LE1").get_json()["data"]
    assert {d["id"] for d in divisions} == {"D1", "D2"}
    doctor = c.get("/api/registry/doctors/E1").get_json()["data"]
    assert doctor["warning"] and "10" in doctor["warning"]       # залишилось менше 20 місць


def test_registry_requires_session(env):
    c, _ = env
    c.delete_cookie("pis_session_token")
    assert c.get("/api/registry/doctors").status_code == 401


def test_create_declaration_rejects_pediatrician_for_adult(env):
    c, router = env
    r = c.post("/api/ehealth/declaration-requests", json={"employee_id": "E2", "division_id": "D2"})
    assert r.status_code == 400 and not any(m == "POST" for m, _, _ in router.calls)


def test_create_declaration_sends_only_employee_and_division(env):
    c, router = env
    router.on("POST", "/api/pis/declaration_requests", 201, {"data": {"id": "DR1", "status": "NEW", "content": "<p>x</p>"}})
    r = c.post("/api/ehealth/declaration-requests", json={"employee_id": "E1", "division_id": "D1", "extra": "x"})
    assert r.status_code == 200
    assert json.loads(router.calls[-1][2]) == {"employee_id": "E1", "division_id": "D1"}


def test_sign_content_and_near_limit_warning(env):
    c, router = env
    router.on("GET", "/api/pis/declaration_requests/DR1", 200, {"data": {
        "id": "DR1", "status": "NEW", "employee_id": "E1",
        "data_to_be_signed": {"id": "DR1", "declaration_number": "0000-AAAA", "person": {"id": "P1", "patient_signed": False},
                              "employee": {"id": "E1"}, "seed": "hash"}}})
    body = c.get("/api/ehealth/declaration-requests/DR1/sign-content").get_json()
    content = json.loads(body["content"])
    assert content["person"]["patient_signed"] is True and content["seed"] == "hash"
    assert body["warning"]
    router.on("GET", "/api/pis/declaration_requests/DR2", 200, {"data": {"id": "DR2", "status": "SIGNED"}})
    assert c.get("/api/ehealth/declaration-requests/DR2/sign-content").status_code == 400


def test_sign_result_messages(env):
    c, router = env
    router.on("PATCH", "/api/pis/declaration_requests/DR1/actions/sign", 201, {"data": {
        "status": "SIGNED", "declaration_number": "0000-AAAA",
        "employee": {"party": {"last_name": "Коваль", "first_name": "Іван"}}}})
    r = c.patch("/api/ehealth/declaration-requests/DR1/sign", json={"signed_content": "U0lHTg=="})
    assert r.get_json()["message"] == "Вітаємо з вибором лікаря! Декларацію № 0000-AAAA лікарю Коваль Іван успішно подано."
    assert sign_result_message({"status": "APPROVED"}) == MSG_APPROVED


def test_declaration_helpers():
    with pytest.raises(ValueError):
        declaration_sign_content({"id": "x"})
    assert limit_warning(None, None) is None
    assert limit_warning(100, 50) is None
    assert "погодження" in limit_warning(100, 100)


def test_dictionaries_cached(env):
    c, router = env
    router.on("GET", "/api/v2/dictionaries", 200, {"data": [{"name": "SPECIALITY_TYPE", "values": []}]})
    c.get("/api/ehealth/dictionaries?name=SPECIALITY_TYPE")
    c.get("/api/ehealth/dictionaries?name=SPECIALITY_TYPE")
    assert sum(1 for m, p, _ in router.calls if p == "/api/v2/dictionaries") == 1   # не частіше ніж раз на 4 год
