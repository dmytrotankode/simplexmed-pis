"""Розділ «Тестування»: доступ (404 для не-тестувальників), вміст, відмітки."""
import os
import sys

import pytest
from flask import Flask

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
import tester  # noqa: E402


class FakeCursor:
    def __init__(self, db): self.db = db; self.rows = []
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, sql, params=None):
        self.db.executed.append((" ".join(sql.split()), params))
        if "FROM PIS_CORE.TESTER_USERS" in sql.upper():
            self.rows = [{"ok": 1}] if self.db.flag else []
        else:
            self.rows = []
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows


class FakeDb:
    def __init__(self, flag=False): self.flag = flag; self.executed = []
    def cursor(self): return FakeCursor(self)
    def commit(self): pass
    def close(self): pass


def make(session, db=None, monkeypatch=None, **env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    app = Flask(__name__)
    db = db or FakeDb()
    tester.register(app, lambda: session, lambda: db)
    return app.test_client(), db


S = {"id": "U1", "tax_id": "3156208746"}


def test_disabled_by_default_returns_404(monkeypatch):
    monkeypatch.delenv("PIS_TESTER_MODE", raising=False)
    c, _ = make(S, monkeypatch=monkeypatch)
    assert c.get("/api/tester/content").status_code == 404


def test_not_a_tester_gets_404(monkeypatch):
    c, _ = make(S, monkeypatch=monkeypatch, PIS_TESTER_MODE="1", PIS_TESTER_TAX_IDS="1111111111")
    assert c.get("/api/tester/content").status_code == 404
    assert c.put("/api/tester/marks", json={"scenario_id": "auth.kep-login", "status": "ok"}).status_code == 404


def test_tester_by_tax_id_sees_content(monkeypatch):
    c, _ = make(S, monkeypatch=monkeypatch, PIS_TESTER_MODE="1", PIS_TESTER_TAX_IDS="1111111111,3156208746")
    body = c.get("/api/tester/content").get_json()
    assert len(body["scenarios"]) >= 20 and any(n["id"] == "3.5.4.8" for n in body["tree"]["nodes"])


def test_tester_by_db_flag_and_marks_validation(monkeypatch):
    monkeypatch.delenv("PIS_TESTER_TAX_IDS", raising=False)
    c, db = make(S, FakeDb(flag=True), monkeypatch=monkeypatch, PIS_TESTER_MODE="1")
    assert c.put("/api/tester/marks", json={"scenario_id": "no.such", "status": "ok"}).status_code == 400
    assert c.put("/api/tester/marks", json={"scenario_id": "auth.kep-login", "status": "maybe"}).status_code == 400
    r = c.put("/api/tester/marks", json={"scenario_id": "auth.kep-login", "status": "ok", "note": "ok"})
    assert r.status_code == 200
    assert any("INSERT INTO pis_core.tester_marks" in sql for sql, _ in db.executed)


def test_unauthenticated_gets_404(monkeypatch):
    c, _ = make(None, monkeypatch=monkeypatch, PIS_TESTER_MODE="1", PIS_TESTER_OPEN="1")
    assert c.get("/api/tester/content").status_code == 404


def test_not_available_on_production_host(monkeypatch):
    monkeypatch.setenv("PIS_TESTER_MODE", "1")
    monkeypatch.setenv("PIS_TESTER_OPEN", "1")
    app = Flask(__name__)
    tester.register(app, lambda: S, lambda: FakeDb())
    c = app.test_client()
    assert c.get("/api/tester/content", headers={"Host": "my.simplex-med.com"}).status_code == 404
    assert c.get("/api/tester/content", headers={"Host": "my-dev.simplex-med.com"}).status_code == 200
