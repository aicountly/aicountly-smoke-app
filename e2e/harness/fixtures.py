"""Identity and helper flows every scenario uses, all through the REAL services' own endpoints and CLIs:
Console staff sign-in (password + e-mailed OTP read from the mail stub), Console caller keys
(scripts/notification_callers.php), portal customer sessions (POST /api/auth/login + /api/seskey),
Flow and Build sessions via the real Console SSO launch-key exchange."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import client, config, pg, proc, services
from .config import SECRETS as S

CONSOLE = lambda: f"{config.url('console')}/api"  # noqa: E731
PORTAL = lambda: f"{config.url('portal')}/api"    # noqa: E731
MANAGE = lambda: f"{config.url('manage')}/api"    # noqa: E731
FLOW = lambda: f"{config.url('flow')}/api"        # noqa: E731
BOOKS = lambda: f"{config.url('books')}/api"      # noqa: E731
BUILD = lambda: f"{config.url('build')}/api"      # noqa: E731

PNO_EMAIL = "pno@aicountly.com"


class Fail(AssertionError):
    pass


def require(*names: str) -> None:
    """NotRun unless every named service/fake booted (the reason names what did not)."""
    from .scenario import NotRun
    down = [f"{n}: {services.UP.get(n, 'not started')}" for n in names if services.UP.get(n) != "up"]
    if down:
        raise NotRun("needs " + "; ".join(down))


def uniq(prefix: str) -> str:
    return f"{prefix}{int(time.time() * 1000) % 10_000_000}"


# ── captured mail ─────────────────────────────────────────────────────────────────────────────
def mail_all() -> list[dict]:
    p = services.MAIL_OUT
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def mail_mark() -> int:
    return len(mail_all())


def mail_since(mark: int) -> list[dict]:
    return mail_all()[mark:]


def wait_mail(pred, mark: int = 0, timeout: float = 20) -> dict | None:
    end = time.time() + timeout
    while time.time() < end:
        for m in mail_since(mark):
            if pred(m):
                return m
        time.sleep(0.2)
    return None


# ── Console ─────────────────────────────────────────────────────────────────────────────────
def console_set_password(email: str, password: str) -> None:
    """One-off password for an EXISTING Console account (migration 006 says: use Console or an explicit
    one-off UPDATE). Used only for the seeded superadmin pno@aicountly.com, whose real hash is unknown here."""
    import subprocess
    h = subprocess.run(["php", "-r", "echo password_hash($argv[1], PASSWORD_BCRYPT);", password],
                       capture_output=True, text=True, check=True).stdout
    n = pg.scalar(config.db("console"),
                  f"WITH u AS (UPDATE users SET password_hash = '{h}' WHERE lower(email) = lower('{email}') RETURNING 1) SELECT count(*) FROM u")
    if n != "1":
        raise Fail(f"Console has no user {email}")


def console_login(email: str, password: str) -> str:
    """Console's real sign-in: POST auth/login -> OTP e-mailed (captured by the mail stub) -> auth/login/complete."""
    mark = mail_mark()
    r = client.post(f"{CONSOLE()}/auth/login", json_body={"email": email, "password": password})
    if r.status != 200 or not (r.json or {}).get("data", {}).get("pending_token"):
        raise Fail(f"Console login({email}) answered {r}")
    pending = r.json["data"]["pending_token"]
    m = wait_mail(lambda m: m["to"].lower() == email.lower() and "verification code" in m["subject"].lower(), mark)
    if not m:
        raise Fail(f"no Console OTP e-mail reached {email} (mail stub)")
    code = re.search(r"\b(\d{6})\b", m["text"] or re.sub("<[^>]+>", " ", m["html"]))
    if not code:
        raise Fail(f"no 6-digit code in the OTP mail: {m['text'][:200]}")
    r = client.post(f"{CONSOLE()}/auth/login/complete", json_body={"pending_token": pending, "otp": code.group(1)})
    token = ((r.json or {}).get("data") or {}).get("token") or ((r.json or {}).get("data") or {}).get("access_token")
    if r.status != 200 or not token:
        raise Fail(f"Console login/complete({email}) answered {r}")
    return token


def console_superadmin() -> str:
    if "pno_console_jwt" in S.values:
        r = client.get(f"{CONSOLE()}/auth/me", bearer=S.values["pno_console_jwt"])
        if r.status == 200:
            return S.values["pno_console_jwt"]
    pw = S.get("pno_password", 12)
    console_set_password(PNO_EMAIL, pw)
    tok = console_login(PNO_EMAIL, pw)
    S.set("pno_console_jwt", tok)
    return tok


def console_create_staff(admin_jwt: str, name: str, email: str, password: str) -> int:
    r = client.post(f"{CONSOLE()}/admin/users", bearer=admin_jwt, json_body={"name": name, "email": email, "password": password})
    if r.status == 409:
        uid = pg.scalar(config.db("console"), f"SELECT id FROM users WHERE lower(email) = lower('{email}')")
        return int(uid)
    if r.status not in (200, 201):
        raise Fail(f"Console POST admin/users ({email}) answered {r}")
    data = r.json.get("data") or {}
    uid = data.get("id") or (data.get("user") or {}).get("id")
    if not uid:
        uid = pg.scalar(config.db("console"), f"SELECT id FROM users WHERE lower(email) = lower('{email}')")
    return int(uid)


def console_grant(admin_jwt: str, user_id: int, app: str, role: str, reason: str = "e2e: assigned by superadmin") -> client.Resp:
    return client.post(f"{CONSOLE()}/admin/rbac/grants", bearer=admin_jwt,
                       json_body={"user_id": user_id, "app_code": app, "role": role, "reason": reason})


def console_revoke(admin_jwt: str, user_id: int, app: str, role: str, reason: str = "e2e: revoked by superadmin") -> client.Resp:
    return client.post(f"{CONSOLE()}/admin/rbac/revocations", bearer=admin_jwt,
                       json_body={"user_id": user_id, "app_code": app, "role": role, "reason": reason})


def console_issue_caller_key(code: str) -> str:
    """Console's own operator CLI prints a portal's key once (capability staff.roles bound to its app code)."""
    api = config.src("console") / "server-php"
    p = proc.php_cli("console", services.load_env("console"), api, ["scripts/notification_callers.php", "issue", code])
    out = p.stdout.decode()
    m = re.search(r"\b(cnnk_[A-Za-z0-9_\-]+)", out)
    if not m:
        raise Fail(f"notification_callers.php issue {code} printed no key: {out[:500]}")
    return m.group(1)


def console_launch_token(console_jwt: str, app: str) -> str:
    r = client.get(f"{CONSOLE()}/auth/sso/launch-url", bearer=console_jwt, query={"app_code": app})
    url = ((r.json or {}).get("data") or {}).get("redirect_url")
    if r.status != 200 or not url:
        raise Fail(f"Console launch-url({app}) answered {r}")
    tok = parse_qs(urlsplit(url).query).get("token", [""])[0]
    if not tok:
        raise Fail(f"Console launch URL carries no token: {url}")
    return tok


# ── Flow / Build sessions through the Console launch key ────────────────────────────────────────
def flow_sso(console_jwt: str) -> client.Resp:
    tok = console_launch_token(console_jwt, "flow")
    return client.post(f"{FLOW()}/auth/controller-sso", json_body={"token": tok})


def flow_session(console_jwt: str) -> dict:
    r = flow_sso(console_jwt)
    d = (r.json or {}).get("data") or {}
    if r.status != 200 or not d.get("token"):
        raise Fail(f"Flow controller-sso answered {r}")
    return d


def build_session(console_jwt: str) -> dict:
    tok = console_launch_token(console_jwt, "build")
    r = client.post(f"{BUILD()}/v1/auth/controller-sso", json_body={"token": tok})
    d = (r.json or {}).get("data") or {}
    if r.status != 200 or not (d.get("token") or d.get("access_token")):
        raise Fail(f"Build controller-sso answered {r}")
    return d


# ── portal customers ───────────────────────────────────────────────────────────────────────────
def portal_login(email: str, password: str) -> dict:
    r = client.post(f"{PORTAL()}/auth/login", json_body={"LoginName": email, "Password": password})
    auth = (r.json or {}).get("aic_auth_token")
    if not auth:
        raise Fail(f"portal auth/login({email}) answered {r}")
    r = client.post(f"{PORTAL()}/seskey", bearer=auth)
    ses = (r.json or {}).get("ses_key")
    if not ses:
        raise Fail(f"portal seskey({email}) answered {r}")
    return {"auth": auth, "ses": ses, "uuid": str((r.json or {}).get("uuid_aictly") or "")}


def extend_session(ses: str, hours: int = 6) -> None:
    """The portal issues 15-minute session keys; long runs move the expiry (documented deviation, the
    key itself is the portal's)."""
    pg.run_sql(config.db("portal"), f"UPDATE aicseskeyn SET aic_ses_expiry = NOW() + INTERVAL '{hours} hours' WHERE aic_ses_key = '{ses}'")


def customer(label: str, uuid: int, first: str, last: str, email: str, mobile: str) -> dict:
    """Create the account (portal user tables) and sign in through the real portal."""
    pw = S.get(f"customer_pw_{label}", 9) + "-Aa1!"
    services.seed_portal_users([{"uuid": uuid, "first": first, "last": last, "email": email, "mobile": mobile, "password": pw}])
    s = portal_login(email, pw)
    extend_session(s["ses"])
    s.update({"email": email, "password": pw, "name": f"{first} {last}", "label": label})
    return s


def manage_create_company(ses: str, name: str, email: str) -> int:
    r = client.post(f"{MANAGE()}/companies/create", bearer=ses, json_body={
        "comp_name": name, "short_name": name.split()[0], "constitution_type": "private_limited",
        "fy_start": "2026-04-01", "fy_end": "2027-03-31", "comp_email": email, "default_stock": "AVG"})
    j = r.json or {}
    cid = j.get("company_id") or j.get("cmp_id") or (j.get("data") or {}).get("cmp_id")
    if r.status != 200 or not cid:
        raise Fail(f"Manage companies/create({name}) answered {r}")
    return int(cid)


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, default=str))
