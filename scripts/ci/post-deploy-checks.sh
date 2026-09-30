#!/usr/bin/env bash
# post-deploy-checks.sh — is the live smoke portal really there, and is it the build just deployed?
#
#   scripts/ci/post-deploy-checks.sh production
#
# Every check goes through scripts/ci/verify-live.sh, which accepts only the app's real answer
# (JSON that satisfies a jq filter, or a page that carries a given string) and asks again from the
# server over VERIFY_SSH when the runner is shown the host's anti-bot page or cannot connect.
# Exits 1 when any check fails; the API's own status only warns. The smoke portal has one
# environment, smoke.aicountly.org. (The PM2 worker is checked by the deploy workflow itself.)
#
# Environment (all optional):
#   EXPECTED_ENTRY     the hashed entry asset of the build just deployed (assets/index-<hash>.js
#                      from frontend/dist/index.html). Empty, as when checking without a deploy:
#                      the page must carry the smoke portal <title> instead.
#   EXPECTED_REVISION  not compared: the smoke API does not report the revision it runs.
#   VERIFY_SSH         the command prefix that runs one command on the server (verify-live.sh).
#   VERIFY_BASE_URL    check this origin instead of smoke.aicountly.org (tests only).
set -uo pipefail

env_name="${1:-}"
case "$env_name" in
  production) host=smoke.aicountly.org ;;
  *) echo "usage: $0 production" >&2; exit 2 ;;
esac
base="${VERIFY_BASE_URL:-https://${host}}"
base="${base%/}"
verify="$(dirname "$0")/verify-live.sh"

failed=0
check() {
  bash "$verify" "$@" || failed=$((failed + 1))
}

# The API: it must be the smoke API (its service name is the host name); its status only warns.
check json "Smoke API (${env_name})" "${base}/api/health" \
  '.service == "smoke.aicountly.org"' \
  '.status == "ok"'

# The SPA: the build just deployed, or (no deploy) the smoke portal page at all.
check page "Smoke SPA (${env_name})" "${base}/" "${EXPECTED_ENTRY:-<title>smoke.aicountly.org</title>}"

if [ "$failed" -ne 0 ]; then
  echo "${failed} post-deploy check(s) failed on ${base}" >&2
  exit 1
fi
echo "All post-deploy checks passed on ${base}"
