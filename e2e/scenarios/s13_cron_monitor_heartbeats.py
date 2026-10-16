"""13. Console's Cron Job Monitor hears the products' cron jobs: Manage's `scripts/product_events.php --deliver`
and `scripts/company_lifecycle.php --apply`, Flow's `scripts/console_audit_deliver.php` and Build's
`spark console:deliver-audit` each report their run to Console POST portal/cron-heartbeat with the monitor
key (CONSOLE_CRON_MONITOR_KEY; Console holds only its hash, CRON_MONITOR_KEY_HASH); the monitor registered
by Console migration 068 records the finished run and reads OK on the superadmin's Cron Monitor screen
(GET admin/cron-monitors/{code}). The products find Console through CONSOLE_API_URL, as their api/.env carries
it. A wrong key and an unregistered monitor are refused."""

import time

from harness import client, config, proc, services
from harness import fixtures as f

ID = "13"
TITLE = "Cron heartbeats: Manage product_events / company_lifecycle, Flow + Build audit delivery -> Console cron_monitors (last run, OK)"
SYSTEMS = "Manage, Flow, Build, Console"

JOBS = [
    ("manage-product-events", "manage", lambda: f.manage_cli(["scripts/product_events.php", "--deliver"])),
    ("manage-company-lifecycle", "manage", lambda: f.manage_cli(["scripts/company_lifecycle.php", "--apply"])),
    ("flow.console_audit_deliver", "flow", lambda: f.flow_cli(["scripts/console_audit_deliver.php"])),
    ("build.console_audit_deliver", "build",
     lambda: proc.php_cli("build", services.load_env("build"), config.src("build") / "server-php", ["spark", "console:deliver-audit"])),
]


def run(ctx):
    f.require("console", "manage", "flow", "build")
    admin = f.console_superadmin()
    t0 = time.time()
    for code, svc, job in JOBS:
        before = len(f.cron_runs(code))
        p = job()
        err = p.stderr.decode(errors="replace")
        runs = f.cron_runs(code)
        new = runs[before:]
        ok = [r for r in new if r["outcome"] == "ok" and r["finished_at"]]
        ctx.check(p.returncode == 0 and ok and "cron-heartbeat" not in err,
                  f"{svc}: one run of the job reports to Console as '{code}' (finished, outcome ok)",
                  f"new heartbeat rows={[(r['run_id'], r['outcome']) for r in new]} {err.strip()[-200:]}")
        r = client.get(f"{f.CONSOLE()}/admin/cron-monitors/{code}", bearer=admin)
        m = ((r.json or {}).get("data") or {}).get("monitor") or {}
        last = m.get("last_completed_run") or m.get("last_run") or {}
        ctx.check(r.status == 200 and str(m.get("state")).lower() == "ok" and last.get("run_id") == ok[-1]["run_id"] if ok else False,
                  f"  Console's Cron Monitor shows '{code}' OK with that run as the last one (GET admin/cron-monitors/{{code}})",
                  f"HTTP {r.status} state={m.get('state')} last={last.get('run_id')} counts={last.get('counts')}")

    r = client.get(f"{f.CONSOLE()}/admin/cron-monitors", bearer=admin)
    mons = {m["code"]: m for m in (((r.json or {}).get("data") or {}).get("monitors") or [])}
    ctx.check(all(str(mons.get(c, {}).get("state")).lower() == "ok" for c, _, _ in JOBS),
              "the monitor list (GET admin/cron-monitors) has all four OK", str({c: mons.get(c, {}).get("state") for c, _, _ in JOBS}))

    k = services.keys()
    body = {"monitor": "manage-product-events", "run_id": f"e2e-forged-{int(t0)}", "outcome": "ok", "finished_at": int(t0)}
    r = client.post(f"{f.CONSOLE()}/portal/cron-heartbeat", headers={"X-Console-Cron-Key": "not-the-key"}, json_body=body)
    ctx.check(r.status == 401, "a heartbeat with a wrong key is refused (401)", f"HTTP {r.status}")
    r = client.post(f"{f.CONSOLE()}/portal/cron-heartbeat", headers={"X-Console-Cron-Key": k["cron_monitor"]},
                    json_body=body | {"monitor": "manage-not-registered"})
    ctx.check(r.status == 404, "a heartbeat for a monitor no migration registered is refused (404, never auto-created)", f"HTTP {r.status}")
