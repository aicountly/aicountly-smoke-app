-- Copied unchanged from console-react-app ops/harness/sql/portal_auth_schema.sql (commit 5ab2c4a), the estate's real-service
-- harness, so this e2e stack builds the portal on the SAME code-derived schema.
-- e2e harness: my.aicountly AUTH database (the `pgr_univaictlydb` connection,
-- env DB_AUTH_*), MINIMAL schema RECONSTRUCTED FROM CODE.
--
-- The my-aicountly-com repo carries no DDL for aicauthtok / aicseskeyn (only
-- database/aicloginotp.sql and 002_useraictly_deletion_cooling_off.sql). The
-- columns below are exactly the ones the portal code reads and writes:
--   server-php/app/Models/Api/AppCommonModel.php  validateSesKey(),
--     generateSesKeyFromAuth(), slideAuthExpiry(), refreshSesKeyUsingAuthToken()
--   web/app/Controllers/Login.php                 create_session() inserts
-- Types are inferred (ids are integers: validateSesKey casts uuid_aictly,
-- aic_auth_id, aic_ses_id with (int)). Production column types/constraints
-- may differ; nothing here is copied from production.

CREATE TABLE IF NOT EXISTS aicauthtok (
    aic_auth_id             BIGSERIAL PRIMARY KEY,
    uuid_aictly             BIGINT       NOT NULL,
    aic_auth_token          TEXT         NULL,
    aic_auth_token_hash     VARCHAR(64)  NULL,
    aic_auth_log_time       TIMESTAMP    NULL,
    aic_auth_last_activity  TIMESTAMP    NULL,
    aic_auth_expiry         TIMESTAMP    NOT NULL,
    aic_auth_log_ip         VARCHAR(64)  NULL,
    aic_auth_login_state    SMALLINT     NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_aicauthtok_hash ON aicauthtok (aic_auth_token_hash);

CREATE TABLE IF NOT EXISTS aicseskeyn (
    aic_ses_id        BIGSERIAL PRIMARY KEY,
    aic_auth_id       BIGINT       NOT NULL,
    uuid_aictly       BIGINT       NOT NULL,
    aic_ses_key       TEXT         NULL,
    aic_ses_key_hash  VARCHAR(64)  NULL,
    aic_ses_log_time  TIMESTAMP    NULL,
    aic_ses_ttl       INTEGER      NULL,
    aic_ses_expiry    TIMESTAMP    NOT NULL,
    aic_ses_log_ip    VARCHAR(64)  NULL,
    aic_ses_state     SMALLINT     NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_aicseskeyn_hash ON aicseskeyn (aic_ses_key_hash);
