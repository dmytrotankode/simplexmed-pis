"""Фаза 2: зміна персональних даних (п.3.10.1–3.10.2) і методи автентифікації (п.3.10.3–3.10.4)."""

import io
import json
import os
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update({"PIS_CLIENT_ID": "CID", "PIS_CLIENT_SECRET": "SECRET"})

import app as A  # noqa: E402
import pis_service as ps  # noqa: E402
from ehealth_pis.registration import person_request_sign_content, validate_person_update  # noqa: E402
from ehealth_pis.transport import HttpResponse  # noqa: E402
from test_phase1 import TODAY, valid_person  # noqa: E402

CURRENT = {**valid_person(), "id": "P1"}


def update_person(**changes):
    person = valid_person()
    person.pop("authentication_methods")
    person.update(changes)
    return person


def test_update_valid_without_auth_methods():
    assert validate_person_update(update_person(), CURRENT, TODAY) == []


def test_update_allows_several_identity_documents():
    person = update_person()
    person["documents"].append({"type": "NATIONAL_ID", "number": "000111222", "issued_at": "2020-01-01",
                                "issued_by": "7413", "expiration_date": "2030-01-01"})
    assert validate_person_update(person, CURRENT, TODAY) == []
    person["documents"] = []
    assert "documents" in [f for f, _ in validate_person_update(person, CURRENT, TODAY)]


def test_tax_id_and_unzr_immutable_once_filled():
    fields = [f for f, _ in validate_person_update(update_person(tax_id="1111111111", unzr="19850412-99999"), CURRENT, TODAY)]
    assert "tax_id" in fields and "unzr" in fields
    fields = [f for f, _ in validate_person_update(update_person(tax_id=None, no_tax_id=True), CURRENT, TODAY)]
    assert "tax_id" in fields


def test_tax_id_can_be_added_when_empty():
    current = {**CURRENT, "tax_id": None, "unzr": None}
    assert validate_person_update(update_person(), current, TODAY) == []


def test_sign_content_sets_patient_signed():
    content = json.loads(person_request_sign_content({"id": "R1", "status": "NEW", "patient_signed": False,
                                                      "person": {"first_name": "Іван"}}))
    assert content == {"id": "R1", "status": "NEW", "patient_signed": True, "person": {"first_name": "Іван"}}


class Router:
    def __init__(self):
        self.routes, self.calls = {}, []

    def on(self, method, path, status, body):
        self.routes[(method, path)] = (status, body)

    def request(self, method, url, headers=None, body=None, timeout=60):
        path = urllib.parse.urlparse(url).path if url.startswith("http") else url
        self.calls.append((method, url, body))
        status, payload = self.routes.get((method, path), (404, {"error": {"message": "nf"}}))
        return HttpResponse(status, json.dumps(payload).encode())


@pytest.fixture
def env(monkeypatch):
    router = Router()
    session = {"session_id": "S1", "id": "U1", "ehealth_person_id": "P1", "ehealth_access_token": "AT",
               "ehealth_refresh_token": "RT", "ehealth_expires_at": datetime.now(timezone.utc) + timedelta(hours=1)}
    monkeypatch.setattr(ps, "get_session", lambda t: dict(session) if t == "T1" else None)
    monkeypatch.setattr(A.ehealth, "transport", router)
    c = A.app.test_client()
    c.set_cookie("pis_session_token", "T1")
    router.on("GET", "/api/pis/person", 200, {"data": CURRENT})
    return c, router


def test_create_person_request_validates_against_current(env):
    c, router = env
    r = c.post("/api/ehealth/person-requests", json={"person": update_person(tax_id="1111111111")})
    assert r.status_code == 422 and "tax_id" in [f["field"] for f in r.get_json()["fields"]]
    assert not any(m == "POST" for m, _, _ in router.calls)


def test_create_person_request_sends_clean_person(env):
    c, router = env
    router.on("POST", "/api/pis/person_requests", 201,
              {"data": {"id": "R1", "status": "NEW"}, "urgent": {"documents": [{"type": "PASSPORT", "url": "https://st/u"}]}})
    person = update_person(second_name="", email="")
    r = c.post("/api/ehealth/person-requests", json={"person": person, "process_disclosure_data_consent": True})
    assert r.status_code == 200 and r.get_json()["data"]["id"] == "R1"
    sent = json.loads([b for m, u, b in router.calls if m == "POST"][0])
    assert sent["patient_signed"] is False and sent["process_disclosure_data_consent"] is True
    # без явної згоди клієнта сервер її не припускає
    c.post("/api/ehealth/person-requests", json={"person": person})
    sent = json.loads([b for m, u, b in router.calls if m == "POST"][-1])
    assert sent["process_disclosure_data_consent"] is False
    assert "second_name" not in sent["person"] and "email" not in sent["person"]


def test_sign_content_route(env):
    c, router = env
    router.on("GET", "/api/pis/person_requests/R1", 200, {"data": {"id": "R1", "status": "NEW", "patient_signed": False}})
    content = json.loads(c.get("/api/ehealth/person-requests/R1/sign-content").get_json()["content"])
    assert content["patient_signed"] is True and content["id"] == "R1"
    router.on("GET", "/api/pis/person_requests/R2", 200, {"data": {"id": "R2", "status": "SIGNED"}})
    assert c.get("/api/ehealth/person-requests/R2/sign-content").status_code == 400


def test_person_request_document_upload_uses_ehealth_url(env):
    c, router = env
    router.on("GET", "/api/pis/person_requests/R1", 200,
              {"data": {"id": "R1"}, "urgent": {"documents": [{"type": "PASSPORT", "is_uploaded": False,
                                                                "url": "https://storage.example/upload/1"}]}})
    router.on("PUT", "/upload/1", 200, {})
    r = c.post("/api/ehealth/person-requests/R1/documents/upload",
               data={"type": "PASSPORT", "url": "http://169.254.169.254/", "file": (io.BytesIO(b"%PDF"), "pass.pdf")},
               content_type="multipart/form-data")
    assert r.status_code == 200
    assert router.calls[-1][0] == "PUT" and router.calls[-1][1] == "https://storage.example/upload/1"
    r = c.post("/api/ehealth/person-requests/R1/documents/upload",
               data={"type": "NATIONAL_ID", "file": (io.BytesIO(b"x"), "id.pdf")}, content_type="multipart/form-data")
    assert r.status_code == 400


def test_complete_and_reject_person_request(env):
    c, router = env
    router.on("PATCH", "/api/pis/person_requests/R1/actions/complete", 200, {"data": {"status": "SIGNED"}})
    router.on("PATCH", "/api/pis/person_requests/R1/actions/reject", 200, {"data": {"status": "REJECTED"}})
    assert c.patch("/api/ehealth/person-requests/R1/complete", json={"signed_content": "U0lHTg=="}).status_code == 200
    assert json.loads(router.calls[-1][2]) == {"signed_content": "U0lHTg==", "signed_content_encoding": "base64"}
    assert c.patch("/api/ehealth/person-requests/R1/reject").status_code == 200


def test_auth_method_flow(env):
    c, router = env
    router.on("POST", "/api/pis/authentication_method_requests", 201, {"data": {"id": "AM1", "status": "NEW"}})
    router.on("PATCH", "/api/pis/authentication_method_requests/AM1/actions/approve", 201,
              {"data": {"id": "AM1", "status": "COMPLETED"}})
    router.on("POST", "/api/pis/authentication_method_requests/AM1/actions/resend_otp", 200, {"data": {}})
    router.on("PATCH", "/api/pis/authentication_methods/M1", 201, {"data": {"alias": "мій"}})
    r = c.post("/api/ehealth/authentication-method-requests", json={"phone_number": "0671112233", "alias": "мій"})
    assert r.get_json()["data"]["status"] == "NEW"
    sent = json.loads(router.calls[-1][2])
    assert sent == {"authentication_method": {"type": "OTP", "phone_number": "+380671112233", "alias": "мій"}}
    assert c.post("/api/ehealth/authentication-method-requests/AM1/resend-otp").status_code == 200
    r = c.patch("/api/ehealth/authentication-method-requests/AM1/approve", json={"verification_code": "1234"})
    assert r.get_json()["data"]["status"] == "COMPLETED"
    assert json.loads(router.calls[-1][2]) == {"verification_code": 1234}
    assert c.patch("/api/ehealth/authentication-methods/M1", json={"alias": " "}).status_code == 400
    assert c.patch("/api/ehealth/authentication-methods/M1", json={"alias": "мій"}).status_code == 200


def test_document_requires_issued_by():
    person = update_person()
    person["documents"][0].pop("issued_by", None)
    assert any(f.endswith(".issued_by") for f, _ in validate_person_update(person, CURRENT, TODAY))


def test_unzr_required_for_national_id_on_registration():
    from ehealth_pis.registration import validate_person_request
    person = update_person()
    person["documents"][0]["type"] = "NATIONAL_ID"
    person["unzr"] = None
    assert "unzr" in [f for f, _ in validate_person_request(person, TODAY)]
