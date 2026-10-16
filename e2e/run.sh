#!/usr/bin/env bash
# AICOUNTLY cross-system end-to-end run: the REAL Console, my.aicountly, Manage, Flow, Smart Books and
# Build servers on this machine, each on its own scratch PostgreSQL database, wired to each other;
# fakes only for e-mail, Tata Smartflo and OVH S3. Writes e2e/report.md. See e2e/README.md.
#
#   e2e/run.sh                 bring up, run all scenarios, report, tear down (stop + drop e2e_* DBs)
#   e2e/run.sh --only 2,3      just those scenarios
#   e2e/run.sh --keep          leave the stack up afterwards;  e2e/run.sh --reuse  runs against it
#   e2e/run.sh --down          stop a kept stack and drop its databases
#
# Environment: E2E_SRC_ROOT (/home/user), E2E_STATE (/tmp/aicountly-e2e), E2E_PORT_BASE (47100),
# E2E_DB_PREFIX (e2e_), E2E_PG_HOST/PORT/USER/PASS (127.0.0.1:5432 postgres/postgres),
# E2E_SRC_<SERVICE>=<dir> to test a worktree, E2E_MOTO_SERVER=<path>,
# E2E_KEEP_DEPS=1 to keep the composer vendor/ dirs and the moto venv this script installed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SRC_ROOT="${E2E_SRC_ROOT:-/home/user}"
export E2E_STATE="${E2E_STATE:-/tmp/aicountly-e2e}"
mkdir -p "$E2E_STATE"
INSTALLED="$E2E_STATE/installed-deps"
touch "$INSTALLED"

die() { echo "e2e: $*" >&2; exit 2; }

for t in php psql pg_isready openssl python3 curl; do command -v "$t" >/dev/null || die "missing tool: $t"; done
# Not `php -m | grep -q`: under pipefail grep -q exits at the first match and php's SIGPIPE fails the pipeline.
PHP_MODULES="$(php -m)"
grep -qi '^pdo_pgsql$' <<<"$PHP_MODULES" || die "php needs pdo_pgsql"
grep -qi '^curl$' <<<"$PHP_MODULES" || die "php needs curl"

if [ "${1:-}" = "--down" ]; then
  cd "$HERE" && python3 -c "
from harness import run, proc
proc.ensure_dirs(); run.down(print)"
  exit 0
fi

src() { # <service> <repo>
  local v="E2E_SRC_$(echo "$1" | tr 'a-z' 'A-Z')"
  echo "${!v:-$E2E_SRC_ROOT/$2}"
}

# Composer dependencies for the two CodeIgniter apps that do not commit vendor/ (Books does).
for pair in portal:my-aicountly-com build:build-aicountly; do
  dir="$(src "${pair%%:*}" "${pair#*:}")/server-php"
  [ -d "$dir" ] || die "${pair%%:*}: $dir not found"
  if [ ! -f "$dir/vendor/autoload.php" ]; then
    command -v composer >/dev/null || die "composer is needed to install $dir/vendor"
    echo "e2e: composer install --no-dev in $dir"
    (cd "$dir" && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --no-progress -q)
    echo "vendor $dir/vendor" >> "$INSTALLED"
  fi
done

# moto_server (S3 stand-in) — in a venv under the state dir unless one is given or on PATH.
if [ -z "${E2E_MOTO_SERVER:-}" ] && ! command -v moto_server >/dev/null; then
  if [ ! -x "$E2E_STATE/venv/bin/moto_server" ]; then
    echo "e2e: installing moto[server] into $E2E_STATE/venv"
    python3 -m venv "$E2E_STATE/venv"
    "$E2E_STATE/venv/bin/pip" install -q 'moto[server]'
    echo "venv $E2E_STATE/venv" >> "$INSTALLED"
  fi
  export E2E_MOTO_SERVER="$E2E_STATE/venv/bin/moto_server"
fi

cleanup_deps() {
  [ "${E2E_KEEP_DEPS:-0}" = 1 ] && return 0
  local kind path
  while read -r kind path; do
    case "$kind:$path" in
      vendor:*/server-php/vendor) [ -d "$path" ] && rm -rf "${path:?}" && echo "e2e: removed $path" ;;
      venv:"$E2E_STATE"/venv) [ -d "$path" ] && rm -rf "${path:?}" && echo "e2e: removed $path" ;;
    esac
  done < "$INSTALLED"
  : > "$INSTALLED"
}

keep=0
for arg in "$@"; do case "$arg" in --keep|--reuse) keep=1 ;; esac; done

set +e
(cd "$HERE" && python3 -m harness.run "$@")
rc=$?
set -e
[ "$keep" = 1 ] || cleanup_deps
exit $rc
