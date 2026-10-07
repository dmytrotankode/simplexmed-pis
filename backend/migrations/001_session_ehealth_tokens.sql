-- SimplexMed PIS: токени ЕСОЗ прив'язуються до сесії кабінету і зберігаються зашифрованими.
-- Застосувати до бази simplex-pis-* перед викаткою коду з ehealth_pis.
--   psql "$DATABASE_PIS_URL" -f pis/backend/migrations/001_session_ehealth_tokens.sql

BEGIN;

ALTER TABLE pis_core.sessions
    ADD COLUMN IF NOT EXISTS ehealth_access_token  TEXT,          -- Fernet(PIS_TOKEN_KEY)
    ADD COLUMN IF NOT EXISTS ehealth_refresh_token TEXT,          -- Fernet(PIS_TOKEN_KEY)
    ADD COLUMN IF NOT EXISTS ehealth_expires_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ehealth_person_id     UUID;

-- Раніше токени ЕСОЗ лежали відкритим текстом у patient_details (на рівні облікового запису).
-- Видаляємо їх: після міграції пацієнт входить через ЕСОЗ заново.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'pis_core' AND table_name = 'patient_details'
                 AND column_name = 'ehealth_access_token') THEN
        UPDATE pis_core.patient_details
        SET ehealth_access_token = NULL, ehealth_refresh_token = NULL, ehealth_expires_at = NULL;
    END IF;
END $$;

COMMIT;
