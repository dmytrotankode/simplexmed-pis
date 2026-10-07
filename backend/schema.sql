-- ==============================================================================
-- SimplexMed 2.0 — Пацієнтська інформаційна система (ПІС)
-- База даних: simplex-pis-dev (Hetzner MFX PostgreSQL: 116.203.211.35:50431)
-- Норматив: Технічні вимоги до ПІС (Наказ НСЗУ № 978 від 08.12.2025)
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS pis_core;

-- Розширення для UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Користувачі системи (Пацієнти)
CREATE TABLE IF NOT EXISTS pis_core.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ehealth_person_id UUID UNIQUE,
    tax_id VARCHAR(10),                     -- РНОКПП (податковий номер)
    unzr VARCHAR(14),                       -- УНЗР
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    second_name VARCHAR(100),
    birth_date DATE,
    gender VARCHAR(10),
    phone VARCHAR(20) NOT NULL UNIQUE,
    email VARCHAR(255),
    auth_provider VARCHAR(50) DEFAULT 'ESOZ_PIS', -- ESOZ_PIS, DIIA, BANK_ID
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Сесії користувачів (Web, iOS, Android, Huawei)
CREATE TABLE IF NOT EXISTS pis_core.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES pis_core.users(id) ON DELETE CASCADE,
    device_id VARCHAR(255) NOT NULL,
    device_platform VARCHAR(20) NOT NULL,    -- WEB, IOS, ANDROID, HUAWEI
    device_name VARCHAR(100),
    push_token TEXT,                        -- APNs, FCM, або HMS Push Token
    refresh_token_hash VARCHAR(255) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Управління доступами / Згодами (Consent Management - п. 3.8 ТВ ПІС)
CREATE TABLE IF NOT EXISTS pis_core.access_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES pis_core.users(id) ON DELETE CASCADE,
    legal_entity_id UUID NOT NULL,
    legal_entity_name VARCHAR(255) NOT NULL,
    doctor_name VARCHAR(255),
    scope_type VARCHAR(50) NOT NULL,         -- ALL_RECORDS, ENCOUNTERS_ONLY, MEDICATIONS
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' -- ACTIVE, REVOKED, EXPIRED
);

-- 4. Записи на прийом та заявки (Online Booking Engine)
CREATE TABLE IF NOT EXISTS pis_core.appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES pis_core.users(id) ON DELETE SET NULL,
    patient_phone VARCHAR(20) NOT NULL,
    patient_name VARCHAR(255) NOT NULL,
    doctor_id UUID NOT NULL,
    doctor_name VARCHAR(255) NOT NULL,
    department_name VARCHAR(255),
    slot_start TIMESTAMPTZ NOT NULL,
    slot_end TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED', -- REQUESTED, CONFIRMED, CANCELLED, COMPLETED
    esoz_linked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Журнал аудиту доступу до персональних даних (п. 2.15 ТВ ПІС / КСЗІ)
CREATE TABLE IF NOT EXISTS pis_core.audit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID,
    action_type VARCHAR(100) NOT NULL,       -- LOGIN, VIEW_EMR, REVOKE_CONSENT, TERMINATE_DECLARATION
    ip_address INET,
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Індекси
CREATE INDEX IF NOT EXISTS idx_pis_users_tax_id ON pis_core.users(tax_id);
CREATE INDEX IF NOT EXISTS idx_pis_users_phone ON pis_core.users(phone);
CREATE INDEX IF NOT EXISTS idx_pis_users_ehealth ON pis_core.users(ehealth_person_id);
CREATE INDEX IF NOT EXISTS idx_pis_sessions_user ON pis_core.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_pis_grants_user ON pis_core.access_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_pis_appointments_user ON pis_core.appointments(user_id);
CREATE INDEX IF NOT EXISTS idx_pis_audit_user ON pis_core.audit_log(user_id);
