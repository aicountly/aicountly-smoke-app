-- Copied unchanged from console-react-app ops/harness/sql/portal_company_schema.sql (commit 5ab2c4a), the estate's real-service
-- harness, so this e2e stack builds the portal on the SAME code-derived schema.
-- AICOUNTLY harness: my.aicountly COMPANY database (the portal's `postgr_cmpaictly_db` connection, env
-- DB_CMP_*), MINIMAL schema RECONSTRUCTED FROM CODE. Test fixture only — never deployed.
--
-- my-aicountly-com carries no DDL for these legacy portal tables. The columns are the ones these read:
--   server-php/app/Models/Api/AppCommonModel.php  user_company_list(), get_comp_fy_info(),
--     CompanyInfo(), get_company_info(), get_comp_ho_adrs_info()
--   server-php/app/Models/Api/BranchModel.php     getBranchList(), branchInCompany(), getBranchInfo()
--   server-php/app/Libraries/Security/CompanyAccess.php  role()  (the portal's company gate)
-- Types are inferred. Manage (ghm_*) is the owner of companies, branches, FYs and membership; the harness
-- seeds these portal tables with the SAME companies/branches/FYs/members so the portal's own company and
-- branch gate (GET /api/companies, /api/companyinfo, /api/branch/list) agrees with Manage.

CREATE TABLE IF NOT EXISTS cmpmastern (
    cmp_id           BIGSERIAL    PRIMARY KEY,
    cmp_name         VARCHAR(200) NOT NULL DEFAULT '',
    cmp_print_name   VARCHAR(200) NOT NULL DEFAULT '',
    cmp_short_name   VARCHAR(100) NOT NULL DEFAULT '',
    cmp_status       SMALLINT     NOT NULL DEFAULT 1,
    uuid_superadmin  BIGINT       NOT NULL DEFAULT 0,
    created_at       TIMESTAMP    NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cmpmstdetn (
    cmp_id           BIGINT       PRIMARY KEY,
    cmp_cin          VARCHAR(32)  NOT NULL DEFAULT '',
    cmp_pan          VARCHAR(16)  NOT NULL DEFAULT '',
    cmp_pan_jurisd   VARCHAR(64)  NOT NULL DEFAULT '',
    cmp_tel          VARCHAR(32)  NOT NULL DEFAULT '',
    cmp_mobile       VARCHAR(32)  NOT NULL DEFAULT '',
    cmp_wa_mobile    VARCHAR(32)  NOT NULL DEFAULT '',
    cmp_email        VARCHAR(255) NOT NULL DEFAULT '',
    cmp_industry     VARCHAR(64)  NOT NULL DEFAULT '',
    cmp_work_nature  VARCHAR(64)  NOT NULL DEFAULT '',
    cmp_const_type   VARCHAR(64)  NOT NULL DEFAULT '',
    cmp_logo         BIGINT       NULL
);

-- uuid_acs_type 1 = owner (uuid_aictly_by), 0 = shared with uuid_aictly_acs
CREATE TABLE IF NOT EXISTS cmpacsmstr (
    cmpacs_id        BIGSERIAL    PRIMARY KEY,
    cmp_id           BIGINT       NOT NULL,
    uuid_aictly_by   BIGINT       NOT NULL DEFAULT 0,
    uuid_aictly_acs  BIGINT       NOT NULL DEFAULT 0,
    uuid_acs_type    SMALLINT     NOT NULL DEFAULT 0,
    created_at       TIMESTAMP    NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cmpacsmstr_cmp ON cmpacsmstr (cmp_id);

CREATE TABLE IF NOT EXISTS cmpfymastr (
    cmpfymastr_id    BIGSERIAL    PRIMARY KEY,
    cmp_id           BIGINT       NOT NULL,
    fy_beg_date      DATE         NOT NULL,
    fy_end_date      DATE         NOT NULL,
    def_val_method   VARCHAR(10)  NOT NULL DEFAULT 'AVG'
);

CREATE TABLE IF NOT EXISTS cmpaddrmst (
    cmpaddr_id       BIGSERIAL    PRIMARY KEY,
    cmp_id           BIGINT       NOT NULL,
    cmp_addr_type    SMALLINT     NOT NULL DEFAULT 1,
    cmp_addr1        VARCHAR(255) NOT NULL DEFAULT '',
    cmp_addr2        VARCHAR(255) NOT NULL DEFAULT '',
    cmp_city         VARCHAR(100) NOT NULL DEFAULT '',
    cmp_state        INTEGER      NOT NULL DEFAULT 0,
    cmp_country      INTEGER      NOT NULL DEFAULT 0,
    cmp_pin_zip      VARCHAR(16)  NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS hobomaster (
    hobo_id          BIGSERIAL    PRIMARY KEY,
    cmp_id           BIGINT       NOT NULL,
    hobo_name        VARCHAR(100) NOT NULL DEFAULT '',
    hobo_alias       VARCHAR(50)  NOT NULL DEFAULT '',
    mark_ho          SMALLINT     NOT NULL DEFAULT 0,
    created_at       TIMESTAMP    NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hobomaster_cmp ON hobomaster (cmp_id);

CREATE TABLE IF NOT EXISTS hoboaddrmt (
    hobo_id          BIGINT       NOT NULL,
    cmp_id           BIGINT       NOT NULL,
    hobo_addr1       VARCHAR(255) NOT NULL DEFAULT '',
    hobo_addr2       VARCHAR(255) NOT NULL DEFAULT '',
    hobo_city        VARCHAR(100) NOT NULL DEFAULT '',
    hobo_state       INTEGER      NOT NULL DEFAULT 0,
    hobo_country     INTEGER      NOT NULL DEFAULT 0,
    hobo_pin_zip     VARCHAR(16)  NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS hobogstinm (
    hobo_gstin_id        BIGSERIAL   PRIMARY KEY,
    hobo_id              BIGINT      NOT NULL,
    cmp_id               BIGINT      NOT NULL,
    hobo_gstin           VARCHAR(20) NOT NULL DEFAULT '',
    hobo_gstin_type      VARCHAR(20) NOT NULL DEFAULT '',
    hobo_gstin_sub_type  VARCHAR(20) NOT NULL DEFAULT '',
    hobo_gstin_state_code VARCHAR(4) NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS hobotanmst (
    hobo_id          BIGINT       NOT NULL,
    cmp_id           BIGINT       NOT NULL,
    hobo_tan         VARCHAR(16)  NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS aicdocidgr (
    doc_id           BIGSERIAL    PRIMARY KEY,
    doc_name         VARCHAR(255) NOT NULL DEFAULT '',
    doc_file_ext     VARCHAR(16)  NOT NULL DEFAULT ''
);
