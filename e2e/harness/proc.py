"""Processes: php -S servers, PHP CLI commands (migrations, cron jobs, workers) and the stub servers.

Every PHP process runs under a clean environment (env -i semantics) holding exactly the service's
variables, with outbound HTTP(S) proxies pointed at a dead port, so a mis-derived *.aicountly.com
host fails fast instead of reaching a real environment. Variables are passed through the process
environment (variables_order=EGPCS); no .env file is ever written into a checkout.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config

PIDS = config.STATE / "pids"
LOGS = config.STATE / "logs"
ENVS = config.STATE / "env"


def ensure_dirs() -> None:
    for d in (PIDS, LOGS, ENVS, config.STATE / "tmp"):
        d.mkdir(parents=True, exist_ok=True)


def port_open(p: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", p)) == 0


def wait_port(p: int, seconds: float = 15) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if port_open(p):
            return True
        time.sleep(0.1)
    return False


def base_env() -> dict[str, str]:
    bh = config.BLACKHOLE
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(config.STATE),
        "TMPDIR": str(config.STATE / "tmp"),
        "LANG": "C.UTF-8",
        "http_proxy": bh, "https_proxy": bh, "HTTP_PROXY": bh, "HTTPS_PROXY": bh,
        "ALL_PROXY": bh, "all_proxy": bh,
        "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost",
    }


def php_ini_args(name: str) -> list[str]:
    ca = config.STATE / "tls" / "ca.pem"
    args = ["-d", "variables_order=EGPCS", "-d", "display_errors=0", "-d", "log_errors=1",
            "-d", f"error_log={LOGS / (name + '.php.log')}", "-d", "opcache.enable_cli=0",
            "-d", "memory_limit=1G", "-d", "date.timezone=UTC"]
    if ca.exists():
        # The stack's own CA (stubs and TLS front doors). Only local hosts are reachable anyway.
        args += ["-d", f"curl.cainfo={ca}", "-d", f"openssl.cafile={ca}"]
    return args


def write_env(name: str, env: dict[str, str]) -> Path:
    ensure_dirs()
    path = ENVS / f"{name}.env"
    path.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
    os.chmod(path, 0o600)
    return path


def start_php(name: str, port: int, docroot: Path, router: Path, env: dict[str, str], cwd: Path | None = None,
              workers: int = 4) -> None:
    if port_open(port):
        raise RuntimeError(f"port {port} ({name}) is already in use — another stack on this E2E_PORT_BASE?")
    write_env(name, env)
    full = base_env() | {"PHP_CLI_SERVER_WORKERS": str(workers)} | env
    log = open(LOGS / f"{name}.log", "ab")
    p = subprocess.Popen(["php"] + php_ini_args(name) + ["-S", f"127.0.0.1:{port}", "-t", str(docroot), str(router)],
                         cwd=str(cwd or docroot), env=full, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                         start_new_session=True)
    (PIDS / f"{name}.pid").write_text(str(p.pid))
    if not wait_port(port, 20):
        raise RuntimeError(f"{name} did not start on :{port} (see {LOGS / (name + '.log')})")


def start_cmd(name: str, argv: list[str], port: int | None, env: dict[str, str] | None = None, cwd: Path | None = None,
              inherit_env: bool = False) -> None:
    ensure_dirs()
    full = (dict(os.environ) if inherit_env else base_env()) | (env or {})
    log = open(LOGS / f"{name}.log", "ab")
    p = subprocess.Popen(argv, cwd=str(cwd) if cwd else None, env=full, stdout=log, stderr=log,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    (PIDS / f"{name}.pid").write_text(str(p.pid))
    if port is not None and not wait_port(port, 30):
        raise RuntimeError(f"{name} did not start on :{port} (see {LOGS / (name + '.log')})")


def php_cli(name: str, env: dict[str, str], cwd: Path, args: list[str], stdin: bytes | None = None,
            timeout: int = 900, check: bool = True) -> subprocess.CompletedProcess:
    """Run a PHP CLI command with exactly the service's environment (+ egress guard). Output goes to
    logs/<name>.cli.log as well as being returned."""
    ensure_dirs()
    full = base_env() | env
    p = subprocess.run(["php"] + php_ini_args(name + ".cli") + args, cwd=str(cwd), env=full, input=stdin,
                       capture_output=True, timeout=timeout)
    with open(LOGS / f"{name}.cli.log", "ab") as fh:
        fh.write(f"\n$ php {' '.join(args)}  (exit {p.returncode})\n".encode())
        fh.write(p.stdout + p.stderr)
    if check and p.returncode != 0:
        raise RuntimeError(f"{name}: php {' '.join(args)} exited {p.returncode}:\n"
                           f"{(p.stdout + p.stderr).decode(errors='replace')[-3000:]}")
    return p


def stop(name: str) -> None:
    f = PIDS / f"{name}.pid"
    if not f.exists():
        return
    try:
        pid = int(f.read_text().strip())
    except ValueError:
        f.unlink(missing_ok=True)
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            break
        except PermissionError:
            break
        for _ in range(30):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
    f.unlink(missing_ok=True)


def stop_all() -> list[str]:
    names = []
    if PIDS.exists():
        for f in PIDS.glob("*.pid"):
            names.append(f.stem)
            stop(f.stem)
    return names


def wait_http(u: str, seconds: float = 30, ok_codes: tuple[int, ...] = ()) -> int:
    """Wait until the URL answers at all (any HTTP status, or one of ok_codes). Returns the status."""
    end = time.time() + seconds
    last = 0
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.time() < end:
        try:
            with opener.open(u, timeout=10) as r:
                last = r.status
        except urllib.error.HTTPError as e:
            last = e.code
        except Exception:
            last = 0
        if last and (not ok_codes or last in ok_codes):
            return last
        time.sleep(0.25)
    return last
