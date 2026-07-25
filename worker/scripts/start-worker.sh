#!/usr/bin/env bash
# Start the smoke Playwright worker on cPanel / Linux.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing worker/.env — copy .env.example and set WORKER_SHARED_TOKEN." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm install --omit=dev
fi

if [[ ! -f dist/index.js ]]; then
  echo "Missing dist/index.js — run npm run worker:build from the repo root before deploy." >&2
  exit 1
fi

echo "Starting smoke worker poll loop (Ctrl+C to stop)..."
exec npm start
