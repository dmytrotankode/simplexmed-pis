"""Тести переносимого клієнта eHealth PIS API на заглушці транспорту (без мережі)."""

import base64
import json
import os
import sys
import time
import urllib.parse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from ehealth_pis import EhealthApiError, PisClient, PisConfig, validate_document_file  # noqa: E402
from ehealth_pis.signing import content_to_sign, strip_bom_from_base64  # noqa: E402
from ehealth_pis.transport import HttpResponse  # noqa: E402


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.responses = []

    def add(self, status, body=None):
        self.responses.append(HttpResponse(status, json.dumps(body).encode() if body is not None else b""))

    def request(self, method, url, headers=None, body=None, timeout=60):
        self.calls.append({"method": method, "url": url, "headers": headers or {},
                           "body": json.loads(body) if body and headers.get("Content-Type") == "application/json" else body,
                           "timeout": timeout})
        if not self.responses:
            raise OSError("connection refused")
        return self.responses.pop(0)


@pytest.fixture
def setup():
    cfg = PisConfig(client_id="CID", client_secret="SECRET", redirect_uri="https://simplex-med.com",
                    psk="PSK", pis_name="SimplexMed", support_contacts="support@simplex-med.com")
    transport = FakeTransport()
    return PisClient(cfg, transport=transport), transport


def test_timeout_must_be_at_least_60():
    with pytest.raises(ValueError):
        PisConfig(client_id="a", client_secret="b", redirect_uri="c", timeout=30)


def test_every_call_sends_api_key_psk_and_60s_timeout(setup):
    client, t = setup
    t.add(200, {"data": {"id": "p1"}})
    client.get_person("AT")
    call = t.calls[0]
    assert call["url"] == "https://pis-preprod.ehealth.gov.ua/api/pis/person"
    assert call["headers"]["API-key"] == "SECRET"
    assert call["headers"]["Authorization"] == "Bearer AT"
    assert call["headers"]["X-Custom-PSK"] == "PSK"
    assert call["timeout"] >= 60


def test_bulk_uses_api_key_without_bearer(setup):
    client, t = setup
    t.add(200, {"data": []})
    client.bulk_employees(depth=5)
    call = t.calls[0]
    assert call["url"].endswith("/api/pis/bulk/employees?depth=5")
    assert "Authorization" not in call["headers"]


def test_get_nonce(setup):
    client, t = setup
    t.add(200, {"data": {"token": "JWT"}})
    assert client.get_nonce() == "JWT"
    assert t.calls[0]["url"] == "https://auth-preprod.ehealth.gov.ua/oauth/nonce"
    assert t.calls[0]["body"] == {"client_id": "CID"}


def test_sign_in_url_contains_signed_user_data_and_state(setup):
    client, _ = setup
    url = client.sign_in_url(state="my-dev|/|n1", user_data="U0lHTkVE")
    parsed = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(parsed.query)
    assert parsed.path == "/sign-in"
    assert q["client_id"] == ["CID"] and q["redirect_uri"] == ["https://simplex-med.com"]
    assert q["user_data"] == ["U0lHTkVE"] and q["state"] == ["my-dev|/|n1"]
    assert "app:read_pis" in q["scope"][0].split()


def test_exchange_code_parses_ehealth_token_format(setup):
    client, t = setup
    exp = int(time.time()) + 3600
    t.add(201, {"data": {"value": "AT", "expires_at": exp, "user_id": "U1", "user": {"person_id": "P1"},
                         "details": {"refresh_token": "RT", "scope": "person:details_pis"}}})
    tokens = client.exchange_code("CODE")
    assert (tokens.access_token, tokens.refresh_token, tokens.person_id, tokens.expires_at) == ("AT", "RT", "P1", exp)
    body = t.calls[0]["body"]["token"]
    assert body["grant_type"] == "authorization_code" and body["code"] == "CODE"
    assert body["client_secret"] == "SECRET" and body["scope"]


def test_refresh_keeps_previous_refresh_token(setup):
    client, t = setup
    t.add(201, {"data": {"value": "AT2", "expires_at": 1, "details": {}}})
    tokens = client.refresh("RT")
    assert tokens.access_token == "AT2" and tokens.refresh_token == "RT"
    assert t.calls[0]["body"]["token"]["grant_type"] == "refresh_token"


def test_logout_calls_auth_host(setup):
    client, t = setup
    t.add(200, {"data": {}})
    client.logout("AT")
    assert t.calls[0]["url"] == "https://auth-preprod.ehealth.gov.ua/auth/logout"
    assert t.calls[0]["headers"]["Authorization"] == "Bearer AT"


def test_path_ids_are_escaped(setup):
    client, t = setup
    t.add(200, {"data": {}})
    client.get_declaration("AT", "../person")
    assert t.calls[0]["url"].endswith("/api/pis/declarations/..%2Fperson")


def test_error_mapped_to_annex1_user_message(setup):
    client, t = setup
    t.add(409, {"meta": {"code": 409}, "error": {"type": "request_conflict", "message": "Division doesn’t exist"}})
    with pytest.raises(EhealthApiError) as e:
        client.create_declaration_request("AT", {"division_id": "x"})
    assert e.value.status == 409
    assert e.value.user_message.startswith("Це місце надання послуг неможливо обрати")


def test_unknown_error_gets_generic_message_with_support_contacts(setup):
    client, t = setup
    t.add(401, {"error": {"type": "access_denied", "message": "Invalid access token"}})
    with pytest.raises(EhealthApiError) as e:
        client.get_person("BAD")
    assert "SimplexMed" in e.value.user_message and "support@simplex-med.com" in e.value.user_message
    assert "[назва ПІС]" not in e.value.user_message


def test_html_block_page_with_200_is_an_error(setup):
    client, t = setup
    t.responses.append(HttpResponse(200, b"<html><head><title>Request Rejected</title></head></html>"))
    with pytest.raises(EhealthApiError) as e:
        client.address_regions()
    assert e.value.error_type == "invalid_response"


def test_network_error_is_wrapped(setup):
    client, _ = setup  # немає відповідей -> OSError у транспорті
    with pytest.raises(EhealthApiError) as e:
        client.get_person("AT")
    assert e.value.status == 0 and e.value.error_type == "network"


def test_terminate_declaration_body(setup):
    client, t = setup
    t.add(200, {"data": {"status": "terminated"}})
    client.terminate_declaration("AT", "D1", "Зміна лікаря")
    call = t.calls[0]
    assert call["method"] == "PATCH" and call["url"].endswith("/api/pis/declarations/D1/actions/terminate")
    assert call["body"] == {"reason_description": "Зміна лікаря"}


def test_sign_declaration_request_body(setup):
    client, t = setup
    t.add(201, {"data": {}})
    client.sign_declaration_request("AT", "R1", "QkFTRTY0")
    assert t.calls[0]["body"] == {"signed_content": "QkFTRTY0", "signed_content_encoding": "base64"}


def test_document_file_rules():
    assert validate_document_file("паспорт.pdf", 1000) is None
    assert validate_document_file("scan.gif", 10) is not None
    assert validate_document_file("big.pdf", 21 * 1024 * 1024) is not None
    assert validate_document_file("файл@1.png", 10) is not None
    assert validate_document_file("scan.png", 10, b"\x89PNG\r\n\x1a\n...") is None
    assert validate_document_file("scan.png", 10, b"<html>") is not None
    assert validate_document_file("doc.pdf", 10, b"%PDF-1.7") is None


def test_signing_helpers_strip_bom():
    b64 = base64.b64encode("﻿{\"a\":1}".encode()).decode()
    assert base64.b64decode(strip_bom_from_base64(b64)).decode() == "{\"a\":1}"
    assert base64.b64decode(content_to_sign({"a": "б"})).decode() == "{\"a\":\"б\"}"


def test_address_lists_collect_every_page(setup):
    client, t = setup
    t.add(200, {"data": [{"name": "A"}, {"name": "B"}], "paging": {"page_number": 1, "page_size": 2, "total_pages": 2}})
    t.add(200, {"data": [{"name": "C"}], "paging": {"page_number": 2, "page_size": 2, "total_pages": 2}})
    result = client.address_regions()
    assert [r["name"] for r in result["data"]] == ["A", "B", "C"]
    assert "page=1" in t.calls[0]["url"] and "page=2" in t.calls[1]["url"] and "page_size=100" in t.calls[0]["url"]


def test_patient_lists_collect_every_page_and_respect_explicit_page(setup):
    client, t = setup
    t.add(200, {"data": [{"id": 1}], "paging": {"page_number": 1, "total_pages": 2}})
    t.add(200, {"data": [{"id": 2}], "paging": {"page_number": 2, "total_pages": 2}})
    assert [d["id"] for d in client.list_declarations("TOK")["data"]] == [1, 2]
    assert "page_size=300" in t.calls[0]["url"]
    t.add(200, {"data": [{"id": 9}], "paging": {"page_number": 2, "total_pages": 5}})
    assert client.list_declarations("TOK", page=2)["data"] == [{"id": 9}]
    assert len(t.calls) == 3   # явна сторінка — один запит


def test_verification_code_keeps_leading_zero(setup):
    client, t = setup
    t.add(200, {"data": {}})
    client.approve_auth_method_request("TOK", "R1", "0123")
    assert t.calls[0]["body"] == {"verification_code": "0123"}
    t.add(200, {"data": {}})
    client.approve_auth_method_request("TOK", "R1", "4567")
    assert t.calls[1]["body"] == {"verification_code": 4567}
