"""Bring the stack up, run the scenarios, write e2e/report.md, tear the stack down.

  python3 -m harness.run [--only 1,4] [--keep] [--reuse] [--report PATH]

  --keep    leave services running and databases in place afterwards (inspect, re-run with --reuse)
  --reuse   do not (re)create anything: run the scenarios against the stack left by --keep
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib
import pkgutil
import platform
import subprocess
import sys
import time
import traceback

from . import config, pg, proc, services, tls
from .config import SECRETS as S
from .scenario import Ctx, execute

STACK = [
    # (name, kind, starter)
    ("mail", "fake: Itwalk e-mail API (captures to JSON lines)", services.up_mail),
    ("s3", "fake: OVH S3 -> moto_server", services.up_s3),
    ("tata", "fake: Tata Smartflo click-to-call + webhooks (HTTPS)", services.up_tata),
    ("console", "real: console-react-app/server-php (plain PHP)", services.up_console),
    ("portal", "real: my-aicountly-com/server-php (CodeIgniter 4)", services.up_portal),
    ("portal_tls", "TLS front door for the real portal (Flow requires https)", services.up_portal_tls),
    ("manage", "real: manage-aicountly/server-php (plain PHP)", services.up_manage),
    ("flow", "real: flow-react-app/server-php (plain PHP)", services.up_flow),
    ("books", "real: books-react-app/server-php (CodeIgniter 4)", services.up_books),
    ("build", "real: build-aicountly/server-php (CodeIgniter 4)", services.up_build),
]


def issue_console_keys() -> None:
    """Flow and Build authenticate to Console with their own caller keys (capability staff.roles), which
    Console's operator CLI prints once. Issued before Flow/Build start, like an operator would."""
    from . import fixtures
    for app in ("flow", "build"):
        S.set(f"console_caller_key_{app}", fixtures.console_issue_caller_key(app))


def reset_state() -> None:
    """A fresh run starts from empty logs, captures and keys (the databases are re-created anyway)."""
    import shutil
    for d in (proc.LOGS, config.STATE / "mail", config.STATE / "tata", config.STATE / "roots", proc.PIDS):
        if d.exists() and str(d).startswith(str(config.STATE)):
            shutil.rmtree(d)
    S.values = {}
    S.save()
    proc.ensure_dirs()


def up(log) -> None:
    pg.ready()
    dropped = pg.drop_all_prefixed()
    if dropped:
        log(f"dropped leftover databases: {', '.join(dropped)}")
    tls.ensure()
    for name, kind, starter in STACK:
        if name in ("portal_tls",) and services.UP.get("portal") != "up":
            services.UP[name] = "portal did not start"
            continue
        t0 = time.time()
        try:
            starter()
            services.UP[name] = "up"
            log(f"  up   {name:<11} {time.time() - t0:5.1f}s  {kind}")
            if name == "console":
                issue_console_keys()
        except Exception as e:  # keep going: scenarios that need it are reported NOT RUN with this reason
            services.UP[name] = f"failed to start: {str(e).splitlines()[0][:300]}"
            log(f"  FAIL {name:<11} {e}")
            (proc.LOGS / f"{name}.boot-error.log").write_text(traceback.format_exc())


def down(log) -> None:
    stopped = proc.stop_all()
    log(f"stopped: {', '.join(sorted(stopped)) or '-'}")
    try:
        dropped = pg.drop_all_prefixed()
        log(f"dropped databases: {', '.join(dropped) or '-'}")
    except Exception as e:
        log(f"could not drop databases: {e}")


def load_scenarios(only: set[str] | None):
    import scenarios  # e2e/scenarios
    mods = []
    for m in sorted(pkgutil.iter_modules(scenarios.__path__), key=lambda m: m.name):
        mod = importlib.import_module(f"scenarios.{m.name}")
        if hasattr(mod, "run") and (not only or mod.ID in only):
            mods.append(mod)
    return sorted(mods, key=lambda m: int(m.ID))


def write_report(path, results: list[tuple], started: float, boot_log: list[str]) -> None:
    from .report import render
    path.write_text(render(results, started, boot_log))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--reuse", action="store_true")
    ap.add_argument("--report", default=str(config.E2E_DIR / "report.md"))
    a = ap.parse_args()
    from pathlib import Path
    report = Path(a.report)
    proc.ensure_dirs()
    boot_log: list[str] = []

    def log(msg: str) -> None:
        boot_log.append(msg)
        print(msg, flush=True)

    started = time.time()
    log(f"AICOUNTLY cross-system e2e — state {config.STATE}, ports {config.PORT_BASE}+, databases {config.DB_PREFIX}*")
    if a.reuse:
        for name, _, _ in STACK:
            services.UP[name] = "up" if proc.port_open(config.port(name)) else "not running (--reuse)"
    else:
        if any(proc.port_open(config.port(n)) for n, _, _ in STACK):
            log("a stack is already running on these ports — stop it first (e2e/run.sh --down) or use --reuse")
            return 2
        reset_state()
        up(log)
    results = []
    try:
        for mod in load_scenarios({s.strip() for s in a.only.split(",") if s.strip()} or None):
            ctx = Ctx(mod.ID, mod.TITLE)
            print(f"\n=== scenario {mod.ID}: {mod.TITLE}", flush=True)
            execute(ctx, mod.run)
            for st, what, detail in ctx.steps:
                print(f"  {st:<4} {what}" + (f"  [{detail[:160]}]" if detail and st != 'PASS' else ""), flush=True)
            print(f"  => {ctx.result} ({ctx.seconds:.1f}s){'  ' + ctx.reason if ctx.reason else ''}", flush=True)
            results.append((mod, ctx))
    finally:
        write_report(report, results, started, boot_log)
        print(f"\nreport: {report}", flush=True)
        if not a.keep and not a.reuse:
            down(log)
    return 0 if results and all(c.result == "PASS" for _, c in results) else 1


if __name__ == "__main__":
    sys.exit(main())
