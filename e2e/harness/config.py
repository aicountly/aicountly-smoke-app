"""Stack layout: where the source checkouts are, which ports and databases each service gets,
and the per-run secrets. Everything is derived from a handful of environment variables so
two stacks (or another worker's harness) can coexist on one machine.

  E2E_SRC_ROOT      directory holding the checkouts (default /home/user)
  E2E_STATE         state dir: logs, env files, captured mail, certificates (default /tmp/aicountly-e2e)
  E2E_PORT_BASE     first port; the stack uses base+0 .. base+19 (default 47100)
  E2E_DB_PREFIX     database name prefix, [a-z][a-z0-9]{1,15}_ (default e2e_)
  E2E_PG_HOST/PORT/USER/PASS   a PostgreSQL 16 superuser (default 127.0.0.1:5432 postgres/postgres)
"""

from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path

HERE = Path(__file__).resolve().parent
E2E_DIR = HERE.parent

SRC_ROOT = Path(os.environ.get("E2E_SRC_ROOT", "/home/user"))
STATE = Path(os.environ.get("E2E_STATE", "/tmp/aicountly-e2e"))
PORT_BASE = int(os.environ.get("E2E_PORT_BASE", "47100"))
DB_PREFIX = os.environ.get("E2E_DB_PREFIX", "e2e_")
if not re.fullmatch(r"[a-z][a-z0-9]{1,15}_", DB_PREFIX):
    raise SystemExit("E2E_DB_PREFIX must match [a-z][a-z0-9]{1,15}_")

PG_HOST = os.environ.get("E2E_PG_HOST", "127.0.0.1")
PG_PORT = int(os.environ.get("E2E_PG_PORT", "5432"))
PG_USER = os.environ.get("E2E_PG_USER", "postgres")
PG_PASS = os.environ.get("E2E_PG_PASS", "postgres")

# Nothing listens here: any upstream the stack does not run (and the outbound-egress guard) points at it.
BLACKHOLE = "http://127.0.0.1:9"

REPOS = {
    "console": "console-react-app",
    "portal": "my-aicountly-com",
    "manage": "manage-aicountly",
    "flow": "flow-react-app",
    "books": "books-react-app",
    "build": "build-aicountly",
}

OFFSETS = {
    # real services
    "console": 0, "portal": 1, "manage": 2, "flow": 3, "books": 4, "build": 5,
    # fakes for external systems + TLS front doors
    "mail": 10,        # Itwalk e-mail API stub (HTTP)
    "tata": 11,        # Tata Smartflo stub (HTTPS — Flow refuses a non-https API base)
    "s3": 12,          # moto_server (OVH S3 stand-in)
    "portal_tls": 13,  # HTTPS front door to the real portal (Flow refuses a non-https restore URL)
}


def port(name: str) -> int:
    return PORT_BASE + OFFSETS[name]


def url(name: str) -> str:
    scheme = "https" if name in ("tata", "portal_tls") else "http"
    return f"{scheme}://127.0.0.1:{port(name)}"


def src(service: str) -> Path:
    override = os.environ.get(f"E2E_SRC_{service.upper()}")
    return Path(override) if override else SRC_ROOT / REPOS[service]


def db(service: str) -> str:
    return f"{DB_PREFIX}{service}"


def pg_url(dbname: str) -> str:
    return f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{dbname}"


class Secrets:
    """Random per-run keys, persisted in STATE/secrets.json so a re-attached run sees the same ones.
    Local only; nothing here is a real credential."""

    def __init__(self) -> None:
        self.path = STATE / "secrets.json"
        self.values: dict[str, str] = {}
        if self.path.exists():
            self.values = json.loads(self.path.read_text())

    def get(self, name: str, nbytes: int = 24, kind: str = "hex") -> str:
        if name not in self.values:
            if kind == "hex":
                self.values[name] = secrets.token_hex(nbytes)
            else:
                self.values[name] = secrets.token_urlsafe(nbytes)
            self.save()
        return self.values[name]

    def set(self, name: str, value: str) -> None:
        self.values[name] = value
        self.save()

    def save(self) -> None:
        STATE.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.values, indent=2))
        os.chmod(self.path, 0o600)


SECRETS = Secrets()
