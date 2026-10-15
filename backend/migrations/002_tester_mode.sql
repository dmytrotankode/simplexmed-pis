-- Розділ «Тестування» (для тестувальників ДП «Електронне здоров'я» і внутрішнього QA).
--   psql "$DATABASE_PIS_URL" -f pis/backend/migrations/002_tester_mode.sql
-- Окремі таблиці: власник pis_core.users — не користувач застосунку, тому users не змінюємо.
BEGIN;

CREATE TABLE IF NOT EXISTS pis_core.tester_users (
    user_id     UUID        PRIMARY KEY,
    kind        TEXT        NOT NULL DEFAULT 'qa',     -- qa | nszu | audit
    valid_until TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pis_core.tester_marks (
    user_id      UUID        NOT NULL,
    scenario_id  TEXT        NOT NULL,
    platform     TEXT        NOT NULL DEFAULT 'web',
    status       TEXT        NOT NULL CHECK (status IN ('ok', 'fail', 'skip')),
    note         TEXT        NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, scenario_id, platform)
);

COMMIT;
