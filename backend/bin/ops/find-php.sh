#!/usr/bin/env bash
# Print the PHP CLI Smoke's server-side commands (spark migrate/seed) should run with, or fail plainly.
#
#   cd <api dir> && PHP="$(bash bin/ops/find-php.sh)" || exit 1
#
# On S01 (since the move off cPanel, 2026-11) the deploy identity's sandbox has no
# `php` on PATH, so a bare `php` in the deploy fails with "php: command not found"
# after the new code is already live. The interpreter is a Remi software collection
# instead (/opt/remi/php84). This looks in the usual places and takes the first PHP
# that is 8.2 or newer (composer.json) with pgsql (the extension CodeIgniter's
# Postgre driver uses; app/Config/Database.php), so the deploy neither guesses one path nor runs migrations on a PHP that cannot
# reach the DB. PHP_BIN, when set, is used only if it passes the same check.
# Adapted from console-react-app server-php/bin/ops/find-php.sh.
set -u

php_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  local v
  v=$("$1" -r 'echo PHP_VERSION_ID;' 2>/dev/null) || return 1
  case "$v" in '' | *[!0-9]*) return 1 ;; esac
  [ "$v" -ge 80200 ] || return 1
  "$1" -m 2>/dev/null | grep -qix 'pgsql'
}

if [ -n "${PHP_BIN:-}" ]; then
  php_ok "$PHP_BIN" && { echo "$PHP_BIN"; exit 0; }
  echo "find-php: PHP_BIN=$PHP_BIN is not PHP >= 8.2 with pgsql" >&2
  exit 1
fi

for c in   "$(command -v php 2>/dev/null || true)"   /opt/remi/php84/root/usr/bin/php /opt/remi/php83/root/usr/bin/php /opt/remi/php82/root/usr/bin/php /opt/remi/php81/root/usr/bin/php   /usr/bin/php84 /usr/bin/php83 /usr/bin/php82 /usr/bin/php81   /usr/local/bin/php /usr/bin/php   /opt/cpanel/ea-php84/root/usr/bin/php /opt/cpanel/ea-php83/root/usr/bin/php /opt/cpanel/ea-php82/root/usr/bin/php /opt/cpanel/ea-php81/root/usr/bin/php; do
  if php_ok "$c"; then
    echo "$c"
    exit 0
  fi
done

echo "find-php: no PHP CLI >= 8.2 with pgsql found (looked on PATH, in /opt/remi/php8x, /usr/bin/php8x, /usr/local/bin, /usr/bin and /opt/cpanel)" >&2
exit 1
