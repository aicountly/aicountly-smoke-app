"""1. Console RBAC -> Flow: a superadmin creates a staff user in Console, grants the Flow role
grievance_officer, the user opens Flow through the real Console launch-key exchange and Flow's session
carries the role; the superadmin revokes it in Console and Flow's next token refresh is refused."""

from harness import client, config, pg
from harness import fixtures as f

ID = "1"
TITLE = "Console RBAC -> Flow (SSO launch key, role sync, revocation on refresh)"
SYSTEMS = "Console, Flow"

EMAIL = "vikram.rana@aicountly.example"
PASSWORD = "Vikram-e2e-Pass1!"


def run(ctx):
    f.require("console", "flow", "mail")
    cdb, fdb = config.db("console"), config.db("flow")

    admin = f.console_superadmin()
    ctx.check(True, "superadmin pno@aicountly.com signs in to Console (password + OTP read from the captured e-mail)")

    uid = f.console_create_staff(admin, "Vikram Rana", EMAIL, PASSWORD)
    row = pg.json_rows(cdb, f"SELECT id, is_active FROM users WHERE id = {uid}")
    ctx.check(row and row[0]["is_active"] is True, "staff user created through Console POST /admin/users", f"console user id {uid}")

    staff = f.console_login(EMAIL, PASSWORD)
    ctx.check(bool(staff), "the new staff user signs in to Console (password + e-mailed OTP)")

    r = client.get(f"{f.CONSOLE()}/auth/sso/launch-url", bearer=staff, query={"app_code": "flow"})
    ctx.check(r.status == 403, "without a Flow role Console refuses to launch Flow", f"HTTP {r.status}")

    r = f.console_grant(admin, uid, "flow", "grievance_officer")
    ctx.check(r.status == 200 and "grievance_officer" in ((r.json or {}).get("data") or {}).get("roles", []),
              "superadmin grants Flow 'grievance_officer' (POST /admin/rbac/grants)", r.text[:200])
    audit = pg.scalar(cdb, f"SELECT count(*) FROM audit_logs WHERE action = 'role.grant' AND entity_id = {uid}")
    ctx.check(audit and int(audit) >= 1, "Console audit_logs records role.grant", f"rows={audit}")

    flow_key = f.S.values.get("console_caller_key_flow", "")
    r = client.get(f"{f.CONSOLE()}/portal/controller-apps/user-access", bearer=flow_key,
                   query={"app_code": "flow", "email": EMAIL})
    d = (r.json or {}).get("data") or {}
    ctx.check(r.status == 200 and d.get("app_access") is True and d.get("app_roles") == ["grievance_officer"],
              "Flow's own Console key (issued by scripts/notification_callers.php) reads the user's Flow roles",
              f"HTTP {r.status} {d}")

    launch = f.console_launch_token(staff, "flow")
    r = client.post(f"{f.FLOW()}/auth/controller-sso", json_body={"token": launch})
    d = (r.json or {}).get("data") or {}
    roles = (d.get("user") or {}).get("roles") or []
    ctx.check(r.status == 200 and d.get("token"), "Flow exchanges the Console launch key (POST /api/auth/controller-sso -> Console /auth/sso/exchange)",
              f"HTTP {r.status}")
    ctx.check("grievance_officer" in roles, "the Flow session carries the Console role", f"user.roles={roles}")
    token = d["token"]

    r = client.post(f"{f.FLOW()}/auth/controller-sso", json_body={"token": launch})
    ctx.check(r.status == 401, "the launch key is single-use (second exchange refused)", f"HTTP {r.status}")

    frow = pg.json_rows(fdb, f"SELECT u.id, u.console_user_id, u.access_revoked_at, array_agg(r.role_slug) AS roles "
                             f"FROM users u LEFT JOIN user_app_roles r ON r.user_id = u.id "
                             f"WHERE lower(u.email) = lower('{EMAIL}') GROUP BY u.id")
    ctx.check(frow and int(frow[0]["console_user_id"] or 0) == uid and "grievance_officer" in (frow[0]["roles"] or []),
              "Flow DB: user provisioned with console_user_id and user_app_roles from Console", str(frow))

    r = client.get(f"{f.FLOW()}/desk/grievances", bearer=token, query={"level": 2})
    ctx.check(r.status == 200, "the role is usable in Flow (GET /api/desk/grievances)", f"HTTP {r.status}")

    r = client.post(f"{f.FLOW()}/auth/refresh", bearer=token)
    ctx.check(r.status == 200 and "grievance_officer" in (((r.json or {}).get("data") or {}).get("user") or {}).get("roles", []),
              "token refresh re-checks Console user-access and keeps the role", f"HTTP {r.status}")

    r = f.console_revoke(admin, uid, "flow", "grievance_officer")
    ctx.check(r.status == 200, "superadmin revokes the role in Console (POST /admin/rbac/revocations)", r.text[:200])
    r = client.get(f"{f.CONSOLE()}/portal/controller-apps/user-access", bearer=flow_key, query={"app_code": "flow", "email": EMAIL})
    d = (r.json or {}).get("data") or {}
    ctx.check(d.get("app_access") is False and d.get("app_roles") == [], "Console user-access now answers app_access=false", str(d))

    r = client.post(f"{f.FLOW()}/auth/refresh", bearer=token)
    ctx.check(r.status == 401, "Flow refuses the next token refresh", f"HTTP {r.status} {r.text[:160]}")
    r = client.get(f"{f.FLOW()}/auth/me", bearer=token)
    ctx.check(r.status == 401, "the existing Flow token is refused on every later request (auth/me)", f"HTTP {r.status}")
    frow = pg.json_rows(fdb, f"SELECT u.access_revoked_at, (SELECT count(*) FROM user_app_roles r WHERE r.user_id = u.id) AS n "
                             f"FROM users u WHERE lower(u.email) = lower('{EMAIL}')")
    ctx.check(frow and frow[0]["access_revoked_at"] and int(frow[0]["n"]) == 0,
              "Flow DB: access_revoked_at set and the synced roles cleared", str(frow))
    r = client.get(f"{f.CONSOLE()}/auth/sso/launch-url", bearer=staff, query={"app_code": "flow"})
    ctx.check(r.status == 403, "Console no longer launches Flow for the user", f"HTTP {r.status}")
