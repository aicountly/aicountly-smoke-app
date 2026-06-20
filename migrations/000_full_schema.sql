-- =============================================================================
-- smoke.aicountly.org -- canonical PostgreSQL schema (mirror of CI4 migrations)
--
-- The CI4 migrations under backend/app/Database/Migrations/ are authoritative.
-- This file is provided for ops-side review and quick provisioning when running
-- without `php spark migrate` (e.g. CI bootstrap).
-- =============================================================================

BEGIN;

-- 01 smoke_users
CREATE TABLE smoke_users (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(191) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(191) NOT NULL,
    status          VARCHAR(32)  NOT NULL DEFAULT 'active',
    must_rotate_pw  BOOLEAN      NOT NULL DEFAULT TRUE,
    mfa_enabled     BOOLEAN      NOT NULL DEFAULT FALSE,
    mfa_secret      VARCHAR(255),
    last_login_at   TIMESTAMP,
    last_login_ip   VARCHAR(64),
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 02 smoke_roles
CREATE TABLE smoke_roles (
    id          BIGSERIAL PRIMARY KEY,
    code        VARCHAR(64) NOT NULL UNIQUE,
    name        VARCHAR(128) NOT NULL,
    description TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 03 smoke_user_roles
CREATE TABLE smoke_user_roles (
    user_id     BIGINT NOT NULL REFERENCES smoke_users(id) ON DELETE CASCADE,
    role_id     BIGINT NOT NULL REFERENCES smoke_roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, role_id)
);

-- 04 smoke_target_profiles
CREATE TABLE smoke_target_profiles (
    id                       BIGSERIAL PRIMARY KEY,
    profile_name             VARCHAR(191) NOT NULL,
    product_name             VARCHAR(64)  NOT NULL,
    environment              VARCHAR(32)  NOT NULL,
    base_url                 VARCHAR(512) NOT NULL,
    login_url                VARCHAR(512) NOT NULL,
    username                 VARCHAR(191) NOT NULL,
    allowed_domains          JSONB,
    allowed_modules          JSONB,
    observer_mode            BOOLEAN NOT NULL DEFAULT TRUE,
    read_only                BOOLEAN NOT NULL DEFAULT TRUE,
    production_restriction   BOOLEAN NOT NULL DEFAULT TRUE,
    allow_safe_demo          BOOLEAN NOT NULL DEFAULT FALSE,
    ip_restriction           JSONB,
    login_strategy           VARCHAR(64) NOT NULL DEFAULT 'standard',
    extra_config             JSONB,
    status                   VARCHAR(32) NOT NULL DEFAULT 'active',
    created_by               BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    updated_by               BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_target_profiles_product ON smoke_target_profiles(product_name);
CREATE INDEX idx_smoke_target_profiles_env     ON smoke_target_profiles(environment);
CREATE INDEX idx_smoke_target_profiles_status  ON smoke_target_profiles(status);

-- 05 smoke_credentials
CREATE TABLE smoke_credentials (
    id                BIGSERIAL PRIMARY KEY,
    target_profile_id BIGINT NOT NULL REFERENCES smoke_target_profiles(id) ON DELETE CASCADE,
    ciphertext        BYTEA NOT NULL,
    nonce             BYTEA NOT NULL,
    auth_tag          BYTEA NOT NULL,
    key_version       INTEGER NOT NULL DEFAULT 1,
    kind              VARCHAR(32) NOT NULL DEFAULT 'password',
    rotated_at        TIMESTAMP,
    created_by        BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 06 smoke_master_prompts
CREATE TABLE smoke_master_prompts (
    id                    BIGSERIAL PRIMARY KEY,
    user_id               BIGINT NOT NULL REFERENCES smoke_users(id) ON DELETE CASCADE,
    target_profile_id     BIGINT NOT NULL REFERENCES smoke_target_profiles(id) ON DELETE CASCADE,
    environment           VARCHAR(32) NOT NULL,
    title                 VARCHAR(191) NOT NULL,
    prompt_text           TEXT NOT NULL,
    parsed_objective_json JSONB,
    brain_response_json   JSONB,
    status                VARCHAR(32) NOT NULL DEFAULT 'draft',
    created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 07 smoke_session_plans
CREATE TABLE smoke_session_plans (
    id               BIGSERIAL PRIMARY KEY,
    master_prompt_id BIGINT NOT NULL REFERENCES smoke_master_prompts(id) ON DELETE CASCADE,
    plan_json        JSONB NOT NULL,
    rationale        TEXT,
    status           VARCHAR(32) NOT NULL DEFAULT 'draft',
    session_count    INTEGER NOT NULL DEFAULT 0,
    approved_by      BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    approved_at      TIMESTAMP,
    rejected_reason  TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 08 smoke_sessions
CREATE TABLE smoke_sessions (
    id                    BIGSERIAL PRIMARY KEY,
    plan_id               BIGINT NOT NULL REFERENCES smoke_session_plans(id) ON DELETE CASCADE,
    ordinal               INTEGER NOT NULL,
    name                  VARCHAR(191) NOT NULL,
    menu_path             VARCHAR(512),
    description           TEXT,
    scope_json            JSONB,
    allowed_actions_json  JSONB,
    destructive_allowed   BOOLEAN NOT NULL DEFAULT FALSE,
    expected_screens      INTEGER NOT NULL DEFAULT 0,
    status                VARCHAR(32) NOT NULL DEFAULT 'pending',
    started_at            TIMESTAMP,
    completed_at          TIMESTAMP,
    error_message         TEXT,
    created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_sessions_plan ON smoke_sessions(plan_id, ordinal);
CREATE INDEX idx_smoke_sessions_status ON smoke_sessions(status);

-- 09 smoke_observation_runs
CREATE TABLE smoke_observation_runs (
    id                BIGSERIAL PRIMARY KEY,
    run_code          VARCHAR(64) NOT NULL UNIQUE,
    plan_id           BIGINT NOT NULL REFERENCES smoke_session_plans(id) ON DELETE CASCADE,
    target_profile_id BIGINT NOT NULL REFERENCES smoke_target_profiles(id) ON DELETE CASCADE,
    product_name      VARCHAR(64) NOT NULL,
    environment       VARCHAR(32) NOT NULL,
    status            VARCHAR(32) NOT NULL DEFAULT 'queued',
    sessions_total    INTEGER NOT NULL DEFAULT 0,
    sessions_done     INTEGER NOT NULL DEFAULT 0,
    sessions_failed   INTEGER NOT NULL DEFAULT 0,
    started_at        TIMESTAMP,
    completed_at      TIMESTAMP,
    triggered_by      BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    reports_dir       VARCHAR(512),
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 10 smoke_session_jobs
CREATE TABLE smoke_session_jobs (
    id                BIGSERIAL PRIMARY KEY,
    run_id            BIGINT NOT NULL REFERENCES smoke_observation_runs(id) ON DELETE CASCADE,
    session_id        BIGINT NOT NULL REFERENCES smoke_sessions(id) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL,
    status            VARCHAR(32) NOT NULL DEFAULT 'queued',
    leased_by         VARCHAR(128),
    leased_at         TIMESTAMP,
    lease_expires_at  TIMESTAMP,
    attempts          INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 2,
    last_error        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_session_jobs_run ON smoke_session_jobs(run_id, ordinal);
CREATE INDEX idx_smoke_session_jobs_status ON smoke_session_jobs(status);

-- 11 smoke_observation_results
CREATE TABLE smoke_observation_results (
    id                  BIGSERIAL PRIMARY KEY,
    run_id              BIGINT NOT NULL REFERENCES smoke_observation_runs(id) ON DELETE CASCADE,
    session_id          BIGINT NOT NULL REFERENCES smoke_sessions(id) ON DELETE CASCADE,
    screen_url          VARCHAR(1024),
    screen_title        VARCHAR(512),
    module_name         VARCHAR(191),
    screenshot_path     VARCHAR(1024),
    page_metadata_json  JSONB,
    console_errors_json JSONB,
    network_errors_json JSONB,
    performance_json    JSONB,
    captured_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_obs_results_run ON smoke_observation_results(run_id);
CREATE INDEX idx_smoke_obs_results_session ON smoke_observation_results(session_id);

-- 12 smoke_ui_inventory
CREATE TABLE smoke_ui_inventory (
    id           BIGSERIAL PRIMARY KEY,
    run_id       BIGINT NOT NULL REFERENCES smoke_observation_runs(id) ON DELETE CASCADE,
    session_id   BIGINT NOT NULL REFERENCES smoke_sessions(id) ON DELETE CASCADE,
    result_id    BIGINT REFERENCES smoke_observation_results(id) ON DELETE SET NULL,
    kind         VARCHAR(64) NOT NULL,
    label        VARCHAR(512),
    selector     VARCHAR(1024),
    url          VARCHAR(1024),
    payload_json JSONB,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_ui_inv_run ON smoke_ui_inventory(run_id);
CREATE INDEX idx_smoke_ui_inv_kind ON smoke_ui_inventory(kind);

-- 13 smoke_ux_issues
CREATE TABLE smoke_ux_issues (
    id              BIGSERIAL PRIMARY KEY,
    run_id          BIGINT NOT NULL REFERENCES smoke_observation_runs(id) ON DELETE CASCADE,
    session_id      BIGINT NOT NULL REFERENCES smoke_sessions(id) ON DELETE CASCADE,
    result_id       BIGINT REFERENCES smoke_observation_results(id) ON DELETE SET NULL,
    category        VARCHAR(64) NOT NULL,
    severity        VARCHAR(16) NOT NULL,
    title           VARCHAR(512) NOT NULL,
    description     TEXT,
    recommendation  TEXT,
    developer_prompt TEXT,
    evidence_json   JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_ux_run ON smoke_ux_issues(run_id);
CREATE INDEX idx_smoke_ux_severity ON smoke_ux_issues(severity);

-- 14 smoke_feature_gaps
CREATE TABLE smoke_feature_gaps (
    id               BIGSERIAL PRIMARY KEY,
    run_id           BIGINT NOT NULL REFERENCES smoke_observation_runs(id) ON DELETE CASCADE,
    session_id       BIGINT REFERENCES smoke_sessions(id) ON DELETE SET NULL,
    product_name     VARCHAR(64) NOT NULL,
    expected_feature VARCHAR(512) NOT NULL,
    observed         BOOLEAN NOT NULL DEFAULT FALSE,
    partial          BOOLEAN NOT NULL DEFAULT FALSE,
    competitor_ref   VARCHAR(191),
    severity         VARCHAR(16) NOT NULL DEFAULT 'medium',
    recommendation   TEXT,
    developer_prompt TEXT,
    notes            TEXT,
    sources_json     JSONB,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_fgaps_run ON smoke_feature_gaps(run_id);
CREATE INDEX idx_smoke_fgaps_product ON smoke_feature_gaps(product_name);

-- 15 smoke_competitor_profiles
CREATE TABLE smoke_competitor_profiles (
    id                BIGSERIAL PRIMARY KEY,
    product_name      VARCHAR(64)  NOT NULL,
    competitor_name   VARCHAR(191) NOT NULL,
    feature_list_json JSONB NOT NULL,
    source_url        VARCHAR(512),
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    notes             TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (product_name, competitor_name)
);

-- 16 smoke_reports
CREATE TABLE smoke_reports (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                BIGINT NOT NULL REFERENCES smoke_observation_runs(id) ON DELETE CASCADE,
    session_id            BIGINT REFERENCES smoke_sessions(id) ON DELETE SET NULL,
    kind                  VARCHAR(32) NOT NULL,
    title                 VARCHAR(255) NOT NULL,
    severity_summary_json JSONB,
    metrics_json          JSONB,
    maturity_score        NUMERIC(5,2),
    ux_score              NUMERIC(5,2),
    html_path             VARCHAR(1024),
    json_path             VARCHAR(1024),
    auditor_visible       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 17 smoke_report_files
CREATE TABLE smoke_report_files (
    id         BIGSERIAL PRIMARY KEY,
    report_id  BIGINT NOT NULL REFERENCES smoke_reports(id) ON DELETE CASCADE,
    file_path  VARCHAR(1024) NOT NULL,
    mime_type  VARCHAR(64)   NOT NULL,
    size_bytes BIGINT,
    sha256     VARCHAR(128),
    kind       VARCHAR(32)   NOT NULL DEFAULT 'evidence',
    created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 18 smoke_settings
CREATE TABLE smoke_settings (
    id          BIGSERIAL PRIMARY KEY,
    key         VARCHAR(128) NOT NULL UNIQUE,
    value_json  JSONB,
    description TEXT,
    is_secret   BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by  BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 19 smoke_audit_logs
CREATE TABLE smoke_audit_logs (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT REFERENCES smoke_users(id) ON DELETE SET NULL,
    action       VARCHAR(128) NOT NULL,
    entity       VARCHAR(64),
    entity_id    VARCHAR(64),
    ip           VARCHAR(64),
    user_agent   VARCHAR(512),
    payload_json JSONB,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smoke_audit_user ON smoke_audit_logs(user_id);
CREATE INDEX idx_smoke_audit_action ON smoke_audit_logs(action);
CREATE INDEX idx_smoke_audit_created ON smoke_audit_logs(created_at);

COMMIT;
