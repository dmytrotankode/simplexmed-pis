"""Кеш реєстрів ЕСОЗ (п.3.12) і пошук лікаря для декларації (п.3.11.1.2–3.11.1.5)."""

import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from ehealth_pis.registry import (MIN_REFRESH_SECONDS, RegistryStore, allowed_specialities,  # noqa: E402
                                  main_speciality)

TODAY = date(2026, 10, 3)


def spec(code, officio=True):
    return {"speciality": code, "speciality_officio": officio, "level": "FIRST"}


DATA = {
    "parties": [
        {"id": "PA1", "first_name": "Іван", "last_name": "Коваль", "second_name": "Петрович", "gender": "MALE",
         "year_of_birth": "1980", "specialities": [spec("FAMILY_DOCTOR")],
         "educations": [{"degree": "MASTER", "speciality": "Лікувальна справа"}]},
        {"id": "PA2", "first_name": "Олена", "last_name": "Шевченко", "gender": "FEMALE", "year_of_birth": "1975",
         "specialities": [spec("PEDIATRICIAN")]},
        {"id": "PA3", "first_name": "Петро", "last_name": "Бондар", "gender": "MALE", "year_of_birth": "1970",
         "specialities": [spec("THERAPIST")]},
        {"id": "PA4", "first_name": "Марія", "last_name": "Хірург", "gender": "FEMALE", "year_of_birth": "1985",
         "specialities": [spec("SURGEON")]},
    ],
    "employees": [
        {"id": "E1", "party_id": "PA1", "legal_entity_id": "LE1", "division_id": "D1", "employee_type": "DOCTOR",
         "status": "APPROVED", "is_active": True, "speciality": spec("FAMILY_DOCTOR")},
        {"id": "E2", "party_id": "PA2", "legal_entity_id": "LE1", "employee_type": "DOCTOR", "status": "APPROVED",
         "is_active": True, "additional_info": {"specialities": [spec("PEDIATRICIAN")]}},
        {"id": "E3", "party_id": "PA3", "legal_entity_id": "LE2", "division_id": "D3", "employee_type": "DOCTOR",
         "status": "APPROVED", "is_active": True, "speciality": spec("THERAPIST")},
        {"id": "E4", "party_id": "PA4", "legal_entity_id": "LE1", "division_id": "D1", "employee_type": "DOCTOR",
         "status": "APPROVED", "is_active": True, "speciality": spec("SURGEON")},
        {"id": "E5", "party_id": "PA1", "legal_entity_id": "LE1", "division_id": "D1", "employee_type": "DOCTOR",
         "status": "DISMISSED", "is_active": False, "speciality": spec("FAMILY_DOCTOR")},
    ],
    "employee_roles": [{"id": "R1", "employee_id": "E2", "healthcare_service_id": "HS2", "status": "ACTIVE"}],
    "healthcare_services": [{"id": "HS2", "legal_entity_id": "LE1", "division_id": "D2", "speciality_type": "PEDIATRICIAN",
                             "status": "ACTIVE", "is_active": True}],
    "divisions": [
        {"id": "D1", "legal_entity_id": "LE1", "name": "Амбулаторія №1", "status": "ACTIVE", "is_active": True,
         "addresses": [{"area": "М.КИЇВ", "settlement": "Київ", "street": "Хрещатик", "building": "1"}]},
        {"id": "D2", "legal_entity_id": "LE1", "name": "Дитяча амбулаторія", "status": "ACTIVE", "is_active": True,
         "addresses": [{"area": "М.КИЇВ", "settlement": "Київ", "street": "Сагайдачного", "building": "5"}]},
        {"id": "D3", "legal_entity_id": "LE2", "name": "ЦПМСД Львів", "status": "ACTIVE", "is_active": True,
         "addresses": [{"area": "ЛЬВІВСЬКА", "settlement": "Львів", "street": "Городоцька"}]},
    ],
    "legal_entities": [
        {"id": "LE1", "name": "КНП ЦПМСД №1", "public_name": "Центр №1", "status": "ACTIVE", "is_active": True},
        {"id": "LE2", "name": "ТОВ Здоров'я Львова", "status": "ACTIVE", "is_active": True},
    ],
    "contract_divisions": [{"division_id": "D1", "contract_id": "C1", "contract_status": "active",
                            "contract_division_status": "active", "contract_end_date": "2027-12-31"}],
    "declarations_limit": [{"party_id": "PA1", "declarations_limit": 1800, "declarations_count": 1790},
                           {"party_id": "PA3", "declarations_limit": 1800, "declarations_count": 1800}],
}


class FakeClient:
    def __init__(self):
        self.calls = []

    def _bulk(self, name, depth=None):
        self.calls.append((name, depth))
        return {"meta": {"date": "2026-10-03T00:00:00Z"}, "data": DATA[name]}

    def __getattr__(self, method):
        if method.startswith("bulk_"):
            name = method[5:]
            return lambda depth=None: self._bulk(name, depth)
        raise AttributeError(method)


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def store(tmp_path):
    clock = Clock()
    s = RegistryStore(str(tmp_path / "registry.sqlite3"), clock=clock)
    client = FakeClient()
    s.refresh_due(client)
    return s, client, clock


def test_full_load_then_delta_not_more_often_than_4h(store):
    s, client, clock = store
    assert ("parties", None) in client.calls and ("declarations_limit", None) in client.calls
    client.calls.clear()
    clock.now += MIN_REFRESH_SECONDS - 60
    assert s.refresh_due(client) == {} and client.calls == []      # ще не минуло 4 години
    clock.now += 120
    s.refresh_due(client)
    assert ("parties", 2) in client.calls                            # дельта за останні дні
    assert ("declarations_limit", None) in client.calls


def test_cache_respects_4h_and_falls_back_on_error(store):
    s, _, clock = store
    calls = []
    fetch = lambda: calls.append(1) or {"data": ["v1"]}
    assert s.cached("dict:GENDER", fetch) == {"data": ["v1"]}
    s.cached("dict:GENDER", fetch)
    assert len(calls) == 1
    clock.now += MIN_REFRESH_SECONDS + 1

    def broken():
        raise OSError("down")
    assert s.cached("dict:GENDER", broken) == {"data": ["v1"]}       # ЕСОЗ недоступна — збережене


def test_main_speciality():
    assert main_speciality({"speciality": spec("THERAPIST")}) == "THERAPIST"
    assert main_speciality({"additional_info": {"specialities": [spec("SURGEON", False), spec("PEDIATRICIAN")]}}) == "PEDIATRICIAN"


def test_allowed_specialities_by_age():
    assert allowed_specialities(35) == {"FAMILY_DOCTOR", "THERAPIST"}
    assert allowed_specialities(10) == {"FAMILY_DOCTOR", "PEDIATRICIAN"}


def names(rows):
    return sorted(r["last_name"] for r in rows)


def test_search_filters_by_patient_age(store):
    s, _, _ = store
    assert names(s.search_doctors(patient_age=35, today=TODAY)) == ["Бондар", "Коваль"]      # без педіатра і хірурга
    assert names(s.search_doctors(patient_age=10, today=TODAY)) == ["Коваль", "Шевченко"]


def test_doctor_division_via_employee_roles(store):
    s, _, _ = store
    row = s.search_doctors(patient_age=10, name="Шевченко", today=TODAY)[0]
    assert row["division_id"] == "D2" and row["legal_entity_name"] == "КНП ЦПМСД №1"


def test_search_filters(store):
    s, _, _ = store
    assert names(s.search_doctors(patient_age=35, name="коваль іван", today=TODAY)) == ["Коваль"]
    assert names(s.search_doctors(patient_age=35, gender="MALE", speciality="THERAPIST", today=TODAY)) == ["Бондар"]
    assert names(s.search_doctors(patient_age=35, legal_entity="здоров'я", today=TODAY)) == ["Бондар"]
    assert names(s.search_doctors(patient_age=35, division="амбулаторія №1", today=TODAY)) == ["Коваль"]
    assert names(s.search_doctors(patient_age=35, address="львів городоцька", today=TODAY)) == ["Бондар"]
    assert names(s.search_doctors(patient_age=35, in_contract=True, today=TODAY)) == ["Коваль"]
    assert names(s.search_doctors(patient_age=35, in_contract=False, today=TODAY)) == ["Бондар"]
    assert names(s.search_doctors(patient_age=35, overlimit=True, today=TODAY)) == ["Бондар"]
    assert names(s.search_doctors(patient_age=35, overlimit=False, today=TODAY)) == ["Коваль"]


def test_declarations_counts_and_contract(store):
    s, _, _ = store
    row = s.search_doctors(patient_age=35, name="Коваль", today=TODAY)[0]
    assert row["declarations_available"] == 10 and row["overlimit"] is False and row["in_contract"] is True
    assert row["age"] == 46


def test_expired_contract_not_counted(store):
    s, _, _ = store
    assert s.search_doctors(patient_age=35, name="Коваль", today=date(2028, 1, 1))[0]["in_contract"] is False


def test_legal_entities_divisions_and_details(store):
    s, _, _ = store
    assert [le["id"] for le in s.search_legal_entities("цпмсд")] == ["LE1"]
    divisions = s.search_divisions(legal_entity_id="LE1", today=TODAY)
    assert {d["id"]: d["in_contract"] for d in divisions} == {"D1": True, "D2": False}
    details = s.doctor_details("E1")
    assert details["last_name"] == "Коваль" and details["educations"][0]["degree"] == "MASTER"
    assert details["declarations_limit"] == 1800
    assert s.doctor_details("NOPE") is None
