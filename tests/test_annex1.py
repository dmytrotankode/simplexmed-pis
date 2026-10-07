"""Таблиця обробки помилок (Додаток 1): розбір PDF-тексту і зіставлення помилок ЕСОЗ з повідомленнями."""

import os
import re
import sys
import time

PIS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PIS, "backend"))
sys.path.insert(0, os.path.join(PIS, "tools"))

import build_annex1  # noqa: E402
from ehealth_pis.errors import Annex1, GENERIC_MESSAGE  # noqa: E402

GENERIC = GENERIC_MESSAGE.replace("[назва ПІС]", "Плексі").replace("[контакти підтримки ПІС]", "support@simplex-med.com")


def annex():
    return Annex1(pis_name="Плексі", support_contacts="support@simplex-med.com")


def test_generated_json_is_up_to_date():
    rows = [build_annex1.parse_row(r) for r in build_annex1._split_rows(build_annex1._clean_lines(build_annex1.SRC))]
    assert rows == [{k: v for k, v in r.items() if not k.startswith("_")} for r in annex().rows], \
        "annex1_errors.json застарів: python pis/tools/build_annex1.py"


def test_all_rows_parsed():
    rows = annex().rows
    assert len(rows) == 373
    assert all(r["user_message"] for r in rows)
    # Повідомлення не містять фрагментів колонки "Опис помилки"
    for r in rows:
        assert not r["user_message"].startswith(("OTP Сталася", "Зверніться до НСЗУ", '"Нова"', "APPROVED")), r
    assert not any(r["method"].startswith("Verify phone number") and len(r["user_message"]) > 300 for r in rows)


def test_each_specific_message_resolves_from_its_error_text():
    """Для кожного рядка з окремим (не загальним) повідомленням помилка ЕСОЗ дає саме це повідомлення."""
    a = annex()
    checked = 0
    for row in a.rows:
        if not row["error"] or row["user_message"].startswith("Сталася помилка. Зверніться до технічної"):
            continue
        # Текст помилки, як його повертає ЕСОЗ: без "message:" і з підставленими значеннями
        error = re.sub(r"^(message|Message|error)\s*:\s*", "", row["error"])
        error = re.sub(r"%\{[^}]*\}|#\s*\{[^}]*\}", "5", error)
        error = re.sub(r"<<?[^<>]*>>?", "PASSPORT", error)
        message, _ = a.resolve(row["method"], row["status"], error)
        assert message == a._render(row["user_message"]), (row["method"], row["status"], row["error"])
        checked += 1
    assert checked >= 40


def test_known_regressions():
    a = annex()
    msg, action = a.resolve("PIS. Sign Declaration request", 422,
                            "Signed content does not match the previously created content")
    assert msg.startswith("Недійсний електронний підпис")
    msg, action = a.resolve("PIS. Terminate declaration", 403, "Access denied. Person is not verified")
    assert msg.startswith("Увага! Персональні дані потребують перевірки.") and "оновлення даних" in action
    msg, _ = a.resolve("PIS. Create authentication method request", 422,
                       "This phone number is present more than 3 times in the system")
    assert msg.startswith("Цей номер телефону перевищив ліміт")
    msg, _ = a.resolve("PIS. Reject Declaration request", 403,
                       "Only declaration request with NEW or APPROVED statuses can be rejected")
    assert msg == GENERIC
    msg, _ = a.resolve("PIS. Patient sign-in", None, "It is impossible to uniquely identify the person.")
    assert msg.startswith("Неможливо однозначно ідентифікувати пацієнта")


def test_method_without_rows_gets_generic_message():
    msg, action = annex().resolve("PIS. Deactivate authentication method", 403, "Access denied. Person is not verified")
    assert msg == GENERIC and action == ""


def test_empty_support_contacts_fall_back_to_default():
    a = Annex1(pis_name="Плексі", support_contacts="")
    assert a.generic_message() == GENERIC


def test_long_hostile_error_text_is_fast():
    a = annex()
    hostile = "required property " * 50000
    started = time.monotonic()
    a.resolve("PIS. Patient sign-up", None, hostile)
    a.resolve("PIS. Complete Update Person details", 422, hostile)
    assert time.monotonic() - started < 1.0
