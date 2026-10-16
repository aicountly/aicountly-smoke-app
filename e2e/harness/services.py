"""Recipes: how each real AICOUNTLY service is migrated (with the repo's OWN canonical runner) and
started under `php -S` (with the repo's own front controller), and how the fakes for external
systems are started. Each recipe returns the environment the service runs with, so scenarios can
run the same service's CLI jobs (purge sweeps, outbox delivery, workers) with identical settings.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import config, pg, proc, tls
from .config import SECRETS as S

STUBS = config.E2E_DIR / "stubs"
SQL = config.E2E_DIR / "sql"
MAIL_OUT = config.STATE / "mail" / "messages.jsonl"
TATA_OUT = config.STATE / "tata" / "calls.jsonl"

ENV: dict[str, dict[str, str]] = {}   # service -> env it runs with (filled by the recipes)
UP: dict[str, str] = {}               # service -> "up" or the reason it could not start
NOTES: dict[str, list[str]] = {}      # service -> deviations / facts worth reporting


def load_env(name: str) -> dict[str, str]:
    """The env a service runs with: from this process's recipes, else from STATE/env/<name>.env."""
    if name not in ENV:
        f = proc.ENVS / f"{name}.env"
        if f.exists():
            ENV[name] = dict(line.split("=", 1) for line in f.read_text().splitlines() if "=" in line)
    return ENV[name]


def note(service: str, text: str) -> None:
    NOTES.setdefault(service, []).append(text)


def git_sha(path: Path) -> str:
    try:
        sha = subprocess.run(["git", "-C", str(path), "rev-parse", "--short=10", "HEAD"], capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True).stdout.strip()
        return sha + ("+dirty" if dirty else "")
    except Exception:
        return "unknown"


def mail_key(service: str) -> str:
    return S.get(f"mail_key_{service}", 12)


# ── shared keys (one per caller → receiver pair, so a log line names who called) ───────────────
def keys() -> dict[str, str]:
    return {
        "console_jwt": S.get("console_jwt", 32),
        "flow_jwt": S.get("flow_jwt", 32),
        "build_jwt": S.get("build_jwt", 32),
        "build_vault": S.get("build_vault", 32),          # 64 hex chars = 32 bytes (AES-256-GCM)
        "flow_build_inbound": S.get("flow_build_inbound", 24),
        "flow_desk_service": S.get("flow_desk_service", 24),
        "manage_desk_inbound": S.get("manage_desk_inbound", 24),
        "manage_purge": S.get("manage_purge", 24),         # my.aicountly -> Manage account-closure
        "account_restore": S.get("account_restore", 24),   # Flow -> my.aicountly internal/account/restore
        "lifecycle_books": S.get("lifecycle_books", 32),   # Manage <-> Books HMAC
        "lifecycle_flow": S.get("lifecycle_flow", 32),     # Manage <-> Flow HMAC (lifecycle-only app, account events)
        "cron_monitor": S.get("cron_monitor", 24),         # products -> Console POST portal/cron-heartbeat
        "inventory_inbound": S.get("inventory_inbound", 24),   # Inventory-like sender -> Books integration/inventory/*
        "inventory_signing": S.get("inventory_signing", 32),   # ... and its X-Inventory-Signature secret
        "manage_inventory_key": S.get("manage_inventory_key", 24),  # Inventory-like sender -> Manage internal/company-status
        "manage_books_key": S.get("manage_books_key", 24),  # Books -> Manage internal/* (label books)
        "manage_console_key": S.get("manage_console_key", 24),  # operator (label console) -> internal/subscriptions
        "manage_books_callback": S.get("manage_books_callback", 32),  # Manage -> Books signed callbacks
        "portal_enc": S.get("portal_enc", 16),
        "books_enc_hex": S.get("books_enc_hex", 32),
        "books_app_enc": S.get("books_app_enc", 16),
        "tata_token": S.get("tata_token", 20),
        "tata_webhook": S.get("tata_webhook", 24),
        "inbound_email": S.get("inbound_email", 24),
        "csat": S.get("csat", 32),
        "s3_access": "e2eaccess", "s3_secret": "e2esecret",
    }


def common_pg(prefix: str = "DB_") -> dict[str, str]:
    return {f"{prefix}HOST": config.PG_HOST, f"{prefix}PORT": str(config.PG_PORT),
            f"{prefix}USER": config.PG_USER}


# ═════════════════════════════════════ fakes ═════════════════════════════════════
def up_mail() -> None:
    MAIL_OUT.parent.mkdir(parents=True, exist_ok=True)
    MAIL_OUT.touch()
    labels = ",".join(f"{mail_key(s)}={s}" for s in ("console", "portal", "manage", "flow", "books", "build"))
    proc.start_cmd("mail-stub", [sys.executable, "-I", str(STUBS / "mail_stub.py"), "--port", str(config.port("mail")),
                                 "--out", str(MAIL_OUT), "--keys", labels], config.port("mail"))


def up_tata() -> None:
    t = tls.ensure()
    k = keys()
    TATA_OUT.parent.mkdir(parents=True, exist_ok=True)
    TATA_OUT.touch()
    webhook = f"{config.url('flow')}/api/public/telephony/tata/webhook?token={k['tata_webhook']}"
    proc.start_cmd("tata-stub", [sys.executable, "-I", str(STUBS / "tata_stub.py"), "--port", str(config.port("tata")),
                                 "--cert", t["cert"], "--key", t["key"], "--token", k["tata_token"],
                                 "--webhook-url", webhook, "--out", str(TATA_OUT)], config.port("tata"))


def moto_server_bin() -> str:
    cand = os.environ.get("E2E_MOTO_SERVER") or shutil.which("moto_server") or str(config.STATE / "venv" / "bin" / "moto_server")
    if not Path(cand).exists():
        raise RuntimeError("moto_server not found: run e2e/run.sh (it installs moto[server] into $E2E_STATE/venv) "
                           "or set E2E_MOTO_SERVER")
    return cand


def up_s3() -> None:
    proc.start_cmd("s3-moto", [moto_server_bin(), "-H", "127.0.0.1", "-p", str(config.port("s3"))], config.port("s3"),
                   env={"MOTO_ALLOW_NONEXISTENT_REGION": "true"})
    # The Flow bucket, created the way an operator would before go-live (path-style, region-less PUT).
    from . import client
    r = client.put(f"{config.url('s3')}/flow.aicountly.org")
    if r.status not in (200, 409):
        raise RuntimeError(f"moto: could not create the Flow bucket: {r}")


def up_portal_tls() -> None:
    t = tls.ensure()
    proc.start_cmd("portal-tls", [sys.executable, "-I", str(STUBS / "tls_front.py"), "--port", str(config.port("portal_tls")),
                                  "--cert", t["cert"], "--key", t["key"], "--target", config.url("portal"),
                                  "--log", str(proc.LOGS / "portal-tls.access.log")], config.port("portal_tls"))


# ═════════════════════════════════════ Console ═════════════════════════════════════
def env_console() -> dict[str, str]:
    k = keys()
    return {
        "APP_ENV": "production",
        "BASE_URL": config.url("console"),
        **common_pg(), "DB_NAME": config.db("console"), "DB_PASS": config.PG_PASS,
        "JWT_SECRET": k["console_jwt"], "TOKEN_TTL_HOURS": "8",
        "CORS_ORIGIN": "http://127.0.0.1", "SUPER_ADMIN_EMAILS": "pno@aicountly.com",
        "SSO_EXCHANGE_REQUIRE_CALLER_KEY": "0",
        "CONTROLLER_APP_CODE": "console", "CONTROLLER_COOKIE_DOMAIN": "", "CONTROLLER_COOKIE_SECURE": "false",
        "CONTROLLER_COOKIE_SAMESITE": "Lax",
        "EMAIL_API_KEY": mail_key("console"), "EMAIL_API_URL": f"{config.url('mail')}/email/1/send",
        "EMAIL_API_FORMAT": "multipart", "AUTH_OTP_EMAIL": "simple",
        "SENDER_EMAIL": "support@aicountly.com", "SENDER_NAME": "AICountly Support",
        "SMS_SKIP_SEND": "true", "WHATSAPP_SKIP_SEND": "true", "AICOUNTLY_METERING_ENABLED": "0",
        "FLOW_API_URL": f"{config.url('flow')}/api", "MANAGE_API_URL": f"{config.url('manage')}/api",
        "MY_ACCOUNT_API_URL": f"{config.url('portal')}/api",
        "FLOW_DB_HOST": config.PG_HOST, "FLOW_DB_PORT": str(config.PG_PORT), "FLOW_DB_NAME": config.db("flow"),
        "FLOW_DB_USER": config.PG_USER, "FLOW_DB_PASS": config.PG_PASS,
        "DIGEST_OFFICE_HOURS_ONLY": "true",
        # Cron Job Monitor ingest (POST portal/cron-heartbeat): the hash form production uses.
        "CRON_MONITOR_KEY_HASH": hashlib.sha256(k["cron_monitor"].encode()).hexdigest(),
    }


def up_console() -> None:
    api = config.src("console") / "server-php"
    env = env_console()
    ENV["console"] = env
    pg.recreate(config.db("console"))
    proc.php_cli("console", env, api, ["scripts/migrate.php"])
    proc.start_php("console", config.port("console"), api / "public", api / "public" / "index.php", env)
    code = proc.wait_http(f"{config.url('console')}/api/auth/me", 30)
    if code == 0:
        raise RuntimeError("console does not answer")


# ═════════════════════════════════════ my.aicountly (portal) ═════════════════════════════════════
def env_portal() -> dict[str, str]:
    k = keys()
    dbn = config.db("portal")
    env = {
        "CI_ENVIRONMENT": "production",
        "APP_ENC_KEY": k["portal_enc"],
        "app.baseURL": f"{config.url('portal')}/api/",
        "app.forceGlobalSecureRequests": "false",
        "MANAGE_API_BASE": config.url("manage"),
        "MANAGE_API_URL": config.url("manage"),
        "MANAGE_ACCOUNT_PURGE_KEY": k["manage_purge"],
        "ACCOUNT_RESTORE_SERVICE_KEY": k["account_restore"],
        # The 30/45-day closure policy is live for this stack's whole simulated timeline (closures are
        # back-dated up to ~46 days): the cut-over ops sets once the policy is deployed.
        "DELETION_POLICY_CUTOVER": "2026-01-01T00:00:00Z",
        "EMAIL_API_KEY": mail_key("portal"), "EMAIL_API_URL": f"{config.url('mail')}/email/1/send",
        "SENDER_EMAIL": "support@aicountly.com", "SENDER_NAME": "AICOUNTLY",
        "SMS_SKIP_SEND": "true",
    }
    # The portal's four connections (users, auth tokens, legacy companies, legacy Books) share one database here.
    for p in ("AUTH", "UUID", "CMP", "BOOKS"):
        env |= {f"DB_{p}_HOST": config.PG_HOST, f"DB_{p}_USER": config.PG_USER, f"DB_{p}_PASS": config.PG_PASS,
                f"DB_{p}_NAME": dbn, f"DB_{p}_PORT": str(config.PG_PORT)}
    return env


def up_portal() -> None:
    src = config.src("portal")
    api = src / "server-php"
    if not (api / "vendor" / "autoload.php").exists():
        raise RuntimeError(f"portal: {api}/vendor is missing — run.sh installs it (composer install --no-dev)")
    for d in ("cache", "logs", "session", "uploads", "debugbar"):
        (api / "writable" / d).mkdir(parents=True, exist_ok=True)
    dbn = config.db("portal")
    pg.recreate(dbn)
    log = proc.LOGS / "portal-schema.log"
    # The repo ships no DDL for its core tables: its own code-derived users fixture, then the
    # estate harness's code-derived auth/company tables, then the repo's own database/*.sql.
    pg.run_file(dbn, src / "tests" / "fixtures" / "portal_uuid_schema.sql", log)
    pg.run_file(dbn, SQL / "portal_auth_schema.sql", log)
    pg.run_file(dbn, SQL / "portal_company_schema.sql", log)
    for f in sorted((api / "database").glob("*.sql")):
        pg.run_file(dbn, f, log)
    note("portal", "schema: repo tests/fixtures/portal_uuid_schema.sql + code-derived auth/company tables "
                   "(console-react-app ops/harness) + repo server-php/database/*.sql — the repo ships no DDL for its core tables")
    env = env_portal()
    ENV["portal"] = env
    root = config.STATE / "roots" / "portal"
    root.mkdir(parents=True, exist_ok=True)
    link = root / "api"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(api)
    proc.start_php("portal", config.port("portal"), root, link / "index.php", env, cwd=root)
    if proc.wait_http(f"{config.url('portal')}/api/validatesession", 60) == 0:
        raise RuntimeError("portal does not answer /api/validatesession")


def restart_portal() -> None:
    proc.stop("portal")
    env = env_portal()
    ENV["portal"] = env
    link = config.STATE / "roots" / "portal" / "api"
    proc.start_php("portal", config.port("portal"), link.parent, link / "index.php", env, cwd=link.parent)
    proc.wait_http(f"{config.url('portal')}/api/validatesession", 60)


def portal_cli(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    api = config.src("portal") / "server-php"
    return proc.php_cli("portal", load_env("portal"), api, ["spark", *args], check=check)


def seed_portal_users(users: list[dict]) -> None:
    import json
    dsn = f"pgsql:host={config.PG_HOST};port={config.PG_PORT};dbname={config.db('portal')}"
    p = subprocess.run(["php", str(config.E2E_DIR / "harness" / "seed_portal_users.php"), dsn, config.PG_USER, config.PG_PASS],
                       input=json.dumps(users).encode(), capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"portal user seed failed: {p.stderr.decode()[-1500:]}")


# ═════════════════════════════════════ Manage ═════════════════════════════════════
def env_manage() -> dict[str, str]:
    k = keys()
    return {
        "APP_ENV": "local", "APP_DEBUG": "false", "APP_PRODUCT": "manage",
        "DB_HOST": config.PG_HOST, "DB_PORT": str(config.PG_PORT), "DB_NAME": config.db("manage"),
        "DB_USER": config.PG_USER, "DB_PASSWORD": config.PG_PASS, "DB_PASS": config.PG_PASS,
        # The Console API base, as a deployed Manage's api/.env carries it; without CONSOLE_DB_DETAILS_KEY the
        # database still comes from DB_NAME / DB_USER. Off production this is where cron heartbeats go.
        "CONSOLE_API_URL": f"{config.url('console')}/api", "CONSOLE_DB_DETAILS_KEY": "",
        "CONSOLE_CRON_MONITOR_KEY": k["cron_monitor"],
        "AICOUNTLY_AUTH_URL": config.url("portal"), "AICOUNTLY_VALIDATE_SESSION_PATH": "/api/validatesession",
        "AICOUNTLY_PORTAL_URL": config.url("portal"),
        "MANAGE_APP_URL": config.url("manage"), "DESK_PORTAL_BASE_URL": config.url("manage"),
        "CORS_ALLOWED_ORIGINS": "*",
        "BOOKS_API_BASE": config.url("books"),
        "CONTACTS_API_BASE": config.BLACKHOLE, "AUDITOR_BASE_URL": config.BLACKHOLE, "CHAT_API_ORIGIN": config.BLACKHOLE,
        "VAULT_APP_API_BASE": "", "CONSOLE_API_ORIGIN": config.BLACKHOLE,
        "OVH_STORAGE_ENDPOINT": config.url("s3"), "OVH_STORAGE_REGION": "ap-south-mum", "OVH_STORAGE_URL_STYLE": "path",
        "OVH_FLOW_STORAGE_ENDPOINT": config.url("s3"), "OVH_FLOW_STORAGE_REGION": "ap-south-mum",
        "OVH_FLOW_STORAGE_URL_STYLE": "path", "OVH_FLOW_STORAGE_BUCKET": "flow.aicountly.org",
        "OVH_FLOW_STORAGE_ACCESS_KEY": k["s3_access"], "OVH_FLOW_STORAGE_SECRET_KEY": k["s3_secret"],
        # Help & Support lives in the Flow database (Manage writes tickets there directly).
        "FLOW_DB_HOST": config.PG_HOST, "FLOW_DB_PORT": str(config.PG_PORT), "FLOW_DB_NAME": config.db("flow"),
        "FLOW_DB_USER": config.PG_USER, "FLOW_DB_PASSWORD": config.PG_PASS, "FLOW_DB_SSLMODE": "disable",
        "FLOW_DESK_API_URL": f"{config.url('flow')}/api/portal/desk", "FLOW_DESK_SERVICE_KEY": k["flow_desk_service"],
        "MANAGE_DESK_INBOUND_KEY": k["manage_desk_inbound"],
        "EMAIL_API_KEY": mail_key("manage"), "EMAIL_API_URL": f"{config.url('mail')}/email/1/send",
        "SENDER_EMAIL": "support@aicountly.com", "SENDER_NAME": "AICountly Support",
        "ASSIGNED_USER_EMAIL": "desk.agent@aicountly.example",
        "MANAGE_PRODUCT_SERVICE_KEYS": f"books:{k['manage_books_key']},console:{k['manage_console_key']},"
                                       f"inventory:{k['manage_inventory_key']}",
        "MANAGE_SUBSCRIPTION_ADMIN_LABELS": "console",
        "MANAGE_ACCOUNT_PURGE_KEY": k["manage_purge"],
        "BOOKS_CALLBACK_SIGNING_KEY": k["manage_books_callback"],
        "LIFECYCLE_WEBHOOK_SECRET_BOOKS": k["lifecycle_books"],
        "LIFECYCLE_WEBHOOK_URL_BOOKS": config.url("books"),
        # Flow: a lifecycle-only app (LIFECYCLE_EXTRA_APPS default "flow,..."): account events only.
        "LIFECYCLE_WEBHOOK_SECRET_FLOW": k["lifecycle_flow"],
        "LIFECYCLE_WEBHOOK_URL_FLOW": config.url("flow"),
        "LIFECYCLE_ALERT_EMAIL": "ops-alerts@aicountly.example",
        "SAAS_ICONS_DIR": str(config.STATE / "manage-icons"),
    }


def up_manage() -> None:
    api = config.src("manage") / "server-php"
    dbn = config.db("manage")
    pg.recreate(dbn)
    # schema.sql grants to the cPanel role; point the grantee at the migrating user (as the estate harness does).
    schema = (api / "database" / "schema.sql").read_text().replace("ghmanageaic_cmpaictly_user", "CURRENT_USER")
    tmp = config.STATE / "tmp" / "manage-schema.sql"
    tmp.write_text(schema)
    pg.run_file(dbn, tmp, proc.LOGS / "manage-schema.log")
    note("manage", "schema: repo database/schema.sql (grantee ghmanageaic_cmpaictly_user -> CURRENT_USER) + scripts/migrate.php --run")
    env = env_manage()
    ENV["manage"] = env
    proc.php_cli("manage", env, api, ["scripts/migrate.php", "--run"])
    proc.start_php("manage", config.port("manage"), api, api / "public" / "index.php", env)
    if proc.wait_http(f"{config.url('manage')}/api/companyinfo?comp_id=1", 30) == 0:
        raise RuntimeError("manage does not answer")


# ═════════════════════════════════════ Flow ═════════════════════════════════════
def env_flow() -> dict[str, str]:
    k = keys()
    return {
        "APP_ENV": "production",
        "BASE_URL": config.url("flow"), "FLOW_APP_URL": config.url("flow"), "FLOW_API_URL": f"{config.url('flow')}/api",
        "DB_HOST": config.PG_HOST, "DB_PORT": str(config.PG_PORT), "DB_NAME": config.db("flow"),
        "DB_USER": config.PG_USER, "DB_PASS": config.PG_PASS,
        "JWT_SECRET": k["flow_jwt"], "TOKEN_TTL_HOURS": "8", "CORS_ORIGIN": "http://127.0.0.1",
        "CONSOLE_API_URL": f"{config.url('console')}/api", "CONSOLE_API_BASE_URL": f"{config.url('console')}/api",
        "CONSOLE_API_TOKEN": S.values.get("console_caller_key_flow", ""), "CONTROLLER_APP_CODE": "flow",
        "SUPER_ADMIN_EMAIL": "pno@aicountly.com", "ASSIGNED_USER_EMAIL": "desk.agent@aicountly.example",
        "DESK_EMAIL_BLOCKLIST": "pno@aicountly.com",
        "MANAGE_PORTAL_URL": config.url("manage"),
        "EMAIL_API_KEY": mail_key("flow"), "EMAIL_API_URL": f"{config.url('mail')}/email/1/send",
        "SENDER_EMAIL": "support@aicountly.com", "SENDER_NAME": "AICountly Support", "REPLY_TO_EMAIL": "support@aicountly.com",
        "SMS_SKIP_SEND": "true",
        "FLOW_DESK_SERVICE_KEY": k["flow_desk_service"],
        "MANAGE_DESK_API_URL": f"{config.url('manage')}/api", "MANAGE_DESK_INBOUND_KEY": k["manage_desk_inbound"],
        "OVH_FLOW_STORAGE_ENDPOINT": config.url("s3"), "OVH_FLOW_STORAGE_REGION": "ap-south-mum",
        "OVH_FLOW_STORAGE_BUCKET": "flow.aicountly.org",
        "OVH_FLOW_STORAGE_ACCESS_KEY": k["s3_access"], "OVH_FLOW_STORAGE_SECRET_KEY": k["s3_secret"],
        "WORKER_BASE_URL": config.BLACKHOLE, "WORKER_API_TOKEN": "",
        "BUILD_API_BASE_URL": f"{config.url('build')}/api/v1", "BUILD_API_TOKEN": k["flow_build_inbound"],
        "TATA_TELE_ENABLED": "true", "TATA_TELE_API_BASE": config.url("tata"), "TATA_TELE_API_TOKEN": k["tata_token"],
        "TATA_TELE_CLICK_TO_CALL_PATH": "/v1/click_to_call", "TATA_TELE_CALLER_ID": "918069990000",
        "TATA_TELE_WEBHOOK_SECRET": k["tata_webhook"],
        "PORTAL_ACCOUNT_RESTORE_URL": f"{config.url('portal_tls')}/api/internal/account/restore",
        "PORTAL_ACCOUNT_RESTORE_KEY": k["account_restore"],
        "INBOUND_EMAIL_TOKEN": k["inbound_email"], "INBOUND_EMAIL_LOG": str(proc.LOGS / "flow-inbound-email.log"),
        "CSAT_TOKEN_SECRET": k["csat"],
        # Company lifecycle kit (account_purge_requested from Manage; acks to Manage)
        "LIFECYCLE_WEBHOOK_SECRET": k["lifecycle_flow"], "MANAGE_API_URL": config.url("manage"),
        "CONSOLE_CRON_MONITOR_KEY": k["cron_monitor"],
    }


FLOW_SKIP_MIGRATIONS = {"006_app_db_grants.sql"}


def up_flow() -> None:
    api = config.src("flow") / "server-php"
    dbn = config.db("flow")
    pg.recreate(dbn)
    log = proc.LOGS / "flow-schema.log"
    # Flow's canonical procedure (README "INITIAL SETUP"): schema.sql, seed.sql, then every migration in order.
    pg.run_file(dbn, api / "database" / "schema.sql", log)
    pg.run_file(dbn, api / "database" / "seed.sql", log)
    for f in sorted((api / "database" / "migrations").glob("*.sql")):
        if f.name in FLOW_SKIP_MIGRATIONS:
            continue
        pg.run_file(dbn, f, log)
    note("flow", "schema: repo schema.sql + seed.sql + every migrations/*.sql in name order (README INITIAL SETUP); "
                 "skipped " + ", ".join(sorted(FLOW_SKIP_MIGRATIONS)) + " (GRANTs to the cPanel API role — the stack connects as the DB owner)")
    env = env_flow()
    ENV["flow"] = env
    proc.start_php("flow", config.port("flow"), api / "public", api / "public" / "index.php", env)
    if proc.wait_http(f"{config.url('flow')}/api/public/desk-taxonomy", 30) == 0:
        raise RuntimeError("flow does not answer")


def restart_flow() -> None:
    """Re-start Flow with the current env (e.g. after Console issued its caller key)."""
    api = config.src("flow") / "server-php"
    proc.stop("flow")
    env = env_flow()
    ENV["flow"] = env
    proc.start_php("flow", config.port("flow"), api / "public", api / "public" / "index.php", env)
    proc.wait_http(f"{config.url('flow')}/api/public/desk-taxonomy", 30)


# ═════════════════════════════════════ Smart Books ═════════════════════════════════════
def env_books() -> dict[str, str]:
    k = keys()
    return {
        "CI_ENVIRONMENT": "production", "BOOKS_ENVIRONMENT": "sandbox", "AIC_ENVIRONMENT": "local",
        "app.baseURL": f"{config.url('books')}/api/", "app.forceGlobalSecureRequests": "false",
        "BOOKS_APP_URL": f"{config.url('books')}/",
        "database.default.hostname": config.PG_HOST, "database.default.port": str(config.PG_PORT),
        "database.default.database": config.db("books"), "database.default.username": config.PG_USER,
        "database.default.password": config.PG_PASS, "database.default.DBDriver": "Postgre",
        "database.default.schema": "public", "database.default.DBDebug": "false",
        "encryption.key": "hex2bin:" + k["books_enc_hex"],
        "APP_ENC_KEY": k["books_app_enc"],
        "PORTAL_AUTH_BASE": config.url("portal"),
        "MANAGE_API_BASE": config.url("manage"), "MANAGE_API_URL": config.url("manage"),
        "MANAGE_PRODUCT_SERVICE_KEY": k["manage_books_key"],
        "LIFECYCLE_WEBHOOK_SECRET": k["lifecycle_books"],
        "MANAGE_CALLBACK_SIGNING_KEY": k["manage_books_callback"],
        # Inventory's direction into Books (signed mode); the Inventory-like stub sender holds the same values.
        "INVENTORY_INBOUND_SERVICE_KEY": k["inventory_inbound"], "INVENTORY_INBOUND_SIGNING_SECRET": k["inventory_signing"],
        "INVENTORY_API_BASE": config.BLACKHOLE, "CONTACTS_API_BASE": config.BLACKHOLE, "PULSE_API_BASE": config.BLACKHOLE,
        "PULSE_API_ORIGIN": config.BLACKHOLE, "HRMS_API_BASE": config.BLACKHOLE, "VAULT_APP_API_BASE": config.BLACKHOLE,
        "GST_VAULT_BASE_URL": config.BLACKHOLE, "GOTENBERG_BASE_URL": config.BLACKHOLE, "DOCS_API_BASE": config.BLACKHOLE,
        "GSP_ALANKIT_BASE_URL": config.BLACKHOLE,
        "CONSOLE_API_URL": "", "CONSOLE_DB_DETAILS_KEY": "",
        "EMAIL_API_KEY": mail_key("books"), "EMAIL_API_URL": f"{config.url('mail')}/email/1/send",
    }


def up_books() -> None:
    api = config.src("books") / "server-php"
    if not (api / "vendor" / "autoload.php").exists():
        raise RuntimeError(f"books: {api}/vendor is missing (books-react-app commits its vendor; restore it)")
    for d in ("cache", "logs", "session", "uploads", "debugbar"):
        (api / "writable" / d).mkdir(parents=True, exist_ok=True)
    pg.recreate(config.db("books"))
    env = env_books()
    ENV["books"] = env
    # The deploy (cpanel-post-deploy-api.sh) runs `spark migrate --all` then `spark books:sql-migrate`. On an
    # EMPTY database some PHP migrations need SQL-migration columns, so the PHP step runs again afterwards
    # (same sequence as the estate harness).
    proc.php_cli("books", env, api, ["spark", "migrate", "--all"], check=False)
    proc.php_cli("books", env, api, ["spark", "books:sql-migrate"])
    proc.php_cli("books", env, api, ["spark", "migrate", "--all"])
    note("books", "schema: spark migrate --all, spark books:sql-migrate, spark migrate --all (deploy order, PHP step repeated on an empty DB)")
    root = config.STATE / "roots" / "books"
    root.mkdir(parents=True, exist_ok=True)
    link = root / "api"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(api / "public")
    proc.start_php("books", config.port("books"), root, link / "index.php", env, cwd=api / "public")
    if proc.wait_http(f"{config.url('books')}/api/system/revision", 60) == 0:
        raise RuntimeError("books does not answer /api/system/revision")


def books_cli(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    api = config.src("books") / "server-php"
    return proc.php_cli("books", load_env("books"), api, ["spark", *args], check=check)


# ═════════════════════════════════════ Build ═════════════════════════════════════
def env_build() -> dict[str, str]:
    k = keys()
    return {
        "CI_ENVIRONMENT": "production",
        "app.baseURL": f"{config.url('build')}/api/", "app.indexPage": "",
        "BUILD_DB_HOST": config.PG_HOST, "BUILD_DB_PORT": str(config.PG_PORT), "BUILD_DB_NAME": config.db("build"),
        "BUILD_DB_USER": config.PG_USER, "BUILD_DB_PASSWORD": config.PG_PASS,
        "BUILD_JWT_SECRET": k["build_jwt"], "BUILD_JWT_TTL_MINUTES": "720", "BUILD_VAULT_KEY": k["build_vault"],
        "BUILD_ALLOWED_ORIGINS": "http://127.0.0.1",
        "BUILD_AI_PROVIDER": "mock", "BUILD_GITHUB_TOKEN": "",
        "BUILD_WORKER_BASE_URL": config.BLACKHOLE, "BUILD_WORKER_API_TOKEN": "",
        "BUILD_FLOW_INBOUND_TOKEN": k["flow_build_inbound"], "BUILD_FLOW_INBOUND_HMAC_SECRET": "",
        "BUILD_CONSOLE_API_BASE_URL": "", "BUILD_CONSOLE_API_TOKEN": "", "BUILD_CONSOLE_INBOUND_TOKEN": "",
        "CONSOLE_API_URL": f"{config.url('console')}/api", "CONTROLLER_APP_CODE": "build",
        "CONSOLE_API_TOKEN": S.values.get("console_caller_key_build", ""),
        "BUILD_OWNER_EMAIL": "pno@aicountly.com", "SUPER_ADMIN_EMAIL": "pno@aicountly.com",
        "CONSOLE_CRON_MONITOR_KEY": k["cron_monitor"],
    }


def up_build() -> None:
    api = config.src("build") / "server-php"
    if not (api / "vendor" / "autoload.php").exists():
        raise RuntimeError(f"build: {api}/vendor is missing — run.sh installs it (composer install --no-dev)")
    for d in ("cache", "logs", "session", "uploads", "debugbar"):
        (api / "writable" / d).mkdir(parents=True, exist_ok=True)
    pg.recreate(config.db("build"))
    env = env_build()
    ENV["build"] = env
    proc.php_cli("build", env, api, ["spark", "migrate", "--all", "-n"])
    note("build", "schema: spark migrate --all -n (docs/deploy.md); no owner seed — staff come from Console")
    _start_build(env)


def _start_build(env: dict[str, str]) -> None:
    api = config.src("build") / "server-php"
    root = config.STATE / "roots" / "build"
    root.mkdir(parents=True, exist_ok=True)
    link = root / "api"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(api)
    proc.start_php("build", config.port("build"), root, link / "index.php", env, cwd=api)
    if proc.wait_http(f"{config.url('build')}/api/health", 60) == 0:
        raise RuntimeError("build does not answer /api/health")


def restart_build() -> None:
    proc.stop("build")
    env = env_build()
    ENV["build"] = env
    _start_build(env)
