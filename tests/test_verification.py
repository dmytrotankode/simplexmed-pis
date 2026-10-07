"""Правила показу статусів верифікації (п.3.9.3 ТВ ПІС)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from ehealth_pis.verification import verification_view  # noqa: E402


def data(**details):
    return {"person_verification": {"verification_status": "NOT_VERIFIED", "details": details}}


def st(status, reason="AUTO", comment=None):
    return {"verification_status": status, "verification_reason": reason, "verification_comment": comment}


def directions(view):
    return [i["direction"] for i in view["items"]]


def test_only_defined_directions_and_no_general_status():
    view = verification_view(data(drfo=st("VERIFIED"), mvs_passport=st("VERIFIED"), legal_capacity=st("VERIFIED"),
                                  dracs_name_change=st("VERIFIED"), unzr=st("IN_REVIEW"), dms_passport=st("VERIFIED")))
    assert directions(view) == ["drfo", "unzr", "dms_passport"]
    assert all(i["direction"] != "general" for i in view["items"])
    assert view["items"][0]["message"] == "Ваші персональні дані підтверджені в реєстрі Державної податкової служби"


def test_dracs_death_only_when_not_verified():
    assert directions(verification_view(data(dracs_death=st("VERIFIED")))) == []
    view = verification_view(data(dracs_death=st("NOT_VERIFIED", comment="Перевірте")), support_url="https://support.example")
    item = view["items"][0]
    assert item["comment"] == "Перевірте" and "https://support.example" in item["message"]
    assert "[url" not in item["message"]


def test_dracs_birth_hidden_for_adults_and_not_needed():
    assert directions(verification_view(data(dracs_birth=st("VERIFICATION_NOT_NEEDED")), patient_age=10)) == []
    assert directions(verification_view(data(dracs_birth=st("NOT_VERIFIED")), patient_age=18)) == []
    assert directions(verification_view(data(dracs_birth=st("NOT_VERIFIED", comment="x")), patient_age=15)) == ["dracs_birth"]


def test_nhs_not_verified_comment_and_documents_triggered():
    view = verification_view(data(nhs=st("NOT_VERIFIED", "MANUAL", "Бракує даних паспорту")))
    assert view["items"][0]["message"].endswith("по причині – Бракує даних паспорту.")
    assert view["documents_required"] is False
    view = verification_view(data(nhs=st("NOT_VERIFIED", "DOCUMENTS_TRIGGERED")))
    assert view["documents_required"] is True
    assert view["items"][0]["message"].startswith("Завантажте копії ваших документів")


def test_empty():
    assert verification_view(None) == {"items": [], "documents_required": False}
