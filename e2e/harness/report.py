"""e2e/report.md: what ran, against which commits, what passed, what failed and why, what was found."""

from __future__ import annotations

import datetime as dt
import platform
import subprocess

from . import config, services


def _php() -> str:
    try:
        return subprocess.run(["php", "-r", "echo PHP_VERSION;"], capture_output=True, text=True).stdout.strip()
    except Exception:
        return "?"


def _pg() -> str:
    try:
        return subprocess.run(["psql", "--version"], capture_output=True, text=True).stdout.strip().split()[-1]
    except Exception:
        return "?"


def _md(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ")


import re

_INTERESTING = re.compile(r"(status=[45]\d\d|HTTP [45]\d\d|error=|failed|refused|invalid_event|not set|Route not found)", re.I)
_NOISE = re.compile(r"(Mailer::send ok|Auth OTP email|service=books op=company/settings|Product service call: caller=|"
                    r"subscription write refused for caller=books|ConsoleIdentityService request failed HTTP 401 for /auth/sso/exchange)")


def log_scan(limit: int = 40) -> list[str]:
    from . import proc
    seen: dict[str, int] = {}
    for f in sorted(proc.LOGS.glob("*.php.log")):
        svc = f.name.split(".")[0]
        for line in f.read_text(errors="replace").splitlines():
            if not _INTERESTING.search(line) or _NOISE.search(line):
                continue
            norm = re.sub(r"^\[[^]]+\]\s*", "", line)
            norm = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<uuid>", norm)
            norm = re.sub(r"\b(uuid|cmp|id|event_id)=\S+", r"\1=<n>", norm)
            key = f"{svc}: {norm[:300]}"
            seen[key] = seen.get(key, 0) + 1
    return [f"{n:>3}x {k}" for k, n in sorted(seen.items(), key=lambda kv: -kv[1])][:limit]


def render(results: list[tuple], started: float, boot_log: list[str]) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    passed = sum(1 for _, c in results if c.result == "PASS")
    failed = sum(1 for _, c in results if c.result == "FAIL")
    notrun = sum(1 for _, c in results if c.result == "NOT RUN")
    out: list[str] = []
    w = out.append
    w("# AICOUNTLY cross-system E2E report")
    w("")
    w(f"Generated {now:%Y-%m-%d %H:%M} UTC by `e2e/run.sh` in aicountly-smoke-app ({now.timestamp() - started:.0f} s wall clock). "
      f"PHP {_php()}, PostgreSQL client {_pg()}, Python {platform.python_version()}.")
    w("")
    w(f"**Result: {passed} passed, {failed} failed, {notrun} not run** (of {len(results)} scenarios).")
    w("")
    w("## Scenarios")
    w("")
    w("| # | Scenario | Systems crossed | Result | Checks | Time |")
    w("|---|---|---|---|---|---|")
    for mod, c in results:
        n_pass = sum(1 for s in c.steps if s[0] == "PASS")
        n_fail = sum(1 for s in c.steps if s[0] == "FAIL")
        w(f"| {c.sid} | {_md(c.title)} | {_md(getattr(mod, 'SYSTEMS', ''))} | **{c.result}** | {n_pass} pass / {n_fail} fail | {c.seconds:.1f}s |")
    w("")
    w("## Stack under test")
    w("")
    w("Every product is the repository's own server code, started with `php -S 127.0.0.1:<port>` on its own front "
      "controller, on its own fresh PostgreSQL database migrated with the repository's own runner, configured only "
      "through process environment variables (no `.env` is written into any checkout). Services call each other over "
      "HTTP with real per-pair keys; outbound proxies point at a dead port, so nothing can reach a live host.")
    w("")
    w("| Service | Source (HEAD) | Port | Database | Boot | How it was built |")
    w("|---|---|---|---|---|---|")
    for name in ("console", "portal", "manage", "flow", "books", "build"):
        src = config.src(name)
        notes = "; ".join(services.NOTES.get(name, [])) or "-"
        w(f"| {name} | {config.REPOS[name]} @ `{services.git_sha(src)}` | {config.port(name)} | `{config.db(name)}` | "
          f"{_md(services.UP.get(name, 'not started'))} | {_md(notes)} |")
    w("")
    w("Fakes, only for systems outside AICOUNTLY:")
    w("")
    w("| Fake | Stands in for | Port | Status |")
    w("|---|---|---|---|")
    w(f"| `e2e/stubs/mail_stub.py` | Itwalk e-mail API (`/email/1/send` multipart, `/email/3/send` JSON) used by Console, Flow, Manage, my.aicountly; every message captured to JSON lines and asserted on | {config.port('mail')} | {services.UP.get('mail', '-')} |")
    w(f"| `moto_server` | OVH Object Storage (S3, path-style, SigV4) — Flow desk attachments bucket `flow.aicountly.org` | {config.port('s3')} | {services.UP.get('s3', '-')} |")
    w(f"| `e2e/stubs/tata_stub.py` | Tata Smartflo click-to-call (`POST /v1/click_to_call`) + call-status webhooks, HTTPS | {config.port('tata')} | {services.UP.get('tata', '-')} |")
    w(f"| `e2e/stubs/tls_front.py` | not a fake: an HTTPS front door to the real portal (Flow only calls an `https://` restore URL; `php -S` has no TLS) | {config.port('portal_tls')} | {services.UP.get('portal_tls', '-')} |")
    w("")
    w("Identity: Console staff sign in with password + the OTP Console e-mails (read from the mail stub); the seeded "
      "superadmin `pno@aicountly.com` gets a one-off password via SQL (its real hash is unknown here — migration 006 "
      "documents an explicit one-off UPDATE for this). Customers are inserted into the portal's user tables and then "
      "sign in through the real `POST /api/auth/login` + `POST /api/seskey`; the 15-minute session key's expiry is "
      "extended in the DB for the run (the key itself is the portal's). Time travel (day 35 / day 46 of a closure) "
      "is a DB timestamp update, stated in each scenario.")
    w("")
    findings = [(c.sid, f) for _, c in results for f in c.findings]
    w("## Findings (defects observed that the scenarios do not assert)")
    w("")
    if findings:
        for sid, text in findings:
            w(f"- (scenario {sid}) {text}")
    else:
        w("- none")
    w("")
    w("## Cross-service errors in the service logs (not asserted; for triage)")
    w("")
    w("Lines from each service's PHP error log that record a failed call to another system or a refused event, "
      "de-duplicated (timestamps and ids stripped). Expected noise is filtered: Inventory, Contacts and the other "
      "services this stack does not run are pointed at a dead port on purpose.")
    w("")
    scan = log_scan()
    if scan:
        w("```")
        out.extend(scan)
        w("```")
    else:
        w("- none")
    w("")
    w("## Scenario detail")
    for mod, c in results:
        w("")
        w(f"### {c.sid}. {c.title} — {c.result}")
        w("")
        if c.reason:
            w(f"Reason: {_md(c.reason)}")
            w("")
        for st, what, detail in c.steps:
            d = f" — `{_md(detail[:300])}`" if detail else ""
            w(f"- {st}: {_md(what)}{d}")
    w("")
    w("## Boot log")
    w("")
    w("```")
    out.extend(boot_log)
    w("```")
    w("")
    w(f"Logs of this run: `{config.STATE}/logs` (php -S access/error logs per service, `*.cli.log` for migrations "
      "and jobs, `http.calls.log` for every request a scenario made); captured mail: "
      f"`{services.MAIL_OUT}`; Smartflo stub: `{services.TATA_OUT}`.")
    return "\n".join(out) + "\n"
