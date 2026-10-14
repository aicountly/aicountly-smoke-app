"""PostgreSQL helpers (psql CLI; no Python driver needed). Every database this harness creates or
drops starts with config.DB_PREFIX — guard() refuses anything else."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from . import config


def _env() -> dict[str, str]:
    e = dict(os.environ)
    e["PGPASSWORD"] = config.PG_PASS
    return e


def _base(dbname: str) -> list[str]:
    return ["psql", "-h", config.PG_HOST, "-p", str(config.PG_PORT), "-U", config.PG_USER, "-d", dbname,
            "-X", "-q", "-v", "ON_ERROR_STOP=1"]


def guard(dbname: str) -> None:
    if not dbname.startswith(config.DB_PREFIX) or not all(c.isalnum() or c == "_" for c in dbname):
        raise RuntimeError(f"refusing to touch database {dbname!r} (not prefixed with {config.DB_PREFIX!r})")


def ready() -> None:
    def ok() -> bool:
        return subprocess.run(["pg_isready", "-h", config.PG_HOST, "-p", str(config.PG_PORT), "-q"]).returncode == 0
    if not ok():
        subprocess.run(["pg_ctlcluster", "16", "main", "start"], capture_output=True)
        for _ in range(40):
            if ok():
                break
            time.sleep(0.5)
    if not ok():
        raise RuntimeError(f"PostgreSQL is not accepting connections on {config.PG_HOST}:{config.PG_PORT}")
    scalar("postgres", "select 1")


def run_sql(dbname: str, sql: str, log: Path | None = None) -> str:
    p = subprocess.run(_base(dbname) + ["-c", sql], capture_output=True, text=True, env=_env())
    if log:
        with open(log, "a") as fh:
            fh.write(p.stdout + p.stderr)
    if p.returncode != 0:
        raise RuntimeError(f"psql {dbname}: {p.stderr.strip()[:2000]}")
    return p.stdout


def run_file(dbname: str, path: Path, log: Path | None = None, extra: list[str] | None = None) -> None:
    p = subprocess.run(_base(dbname) + (extra or []) + ["-f", str(path)], capture_output=True, text=True, env=_env())
    if log:
        with open(log, "a") as fh:
            fh.write(f"-- {path}\n{p.stdout}{p.stderr}")
    if p.returncode != 0:
        raise RuntimeError(f"psql {dbname} -f {path}: {p.stderr.strip()[-2000:]}")


def rows(dbname: str, sql: str) -> list[list[str]]:
    """Unaligned, tab-separated rows (NULL as the empty string)."""
    p = subprocess.run(_base(dbname) + ["-A", "-t", "-F", "\t", "-c", sql], capture_output=True, text=True, env=_env())
    if p.returncode != 0:
        raise RuntimeError(f"psql {dbname}: {p.stderr.strip()[:2000]}")
    out = []
    for line in p.stdout.splitlines():
        if line == "":
            continue
        out.append(line.split("\t"))
    return out


def scalar(dbname: str, sql: str) -> str | None:
    r = rows(dbname, sql)
    return r[0][0] if r and r[0] else None


def json_rows(dbname: str, sql: str) -> list[dict]:
    """Rows of an arbitrary query as dicts (via row_to_json)."""
    import json
    r = rows(dbname, f"SELECT row_to_json(q)::text FROM ({sql}) q")
    return [json.loads(x[0]) for x in r]


def recreate(dbname: str) -> None:
    guard(dbname)
    run_sql("postgres", f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
    run_sql("postgres", f'CREATE DATABASE "{dbname}"')


def drop(dbname: str) -> None:
    guard(dbname)
    run_sql("postgres", f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')


def drop_all_prefixed() -> list[str]:
    names = [r[0] for r in rows("postgres", f"SELECT datname FROM pg_database WHERE starts_with(datname, '{config.DB_PREFIX}')")]
    for n in names:
        drop(n)
    return names
