#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${ALMMA_TURNSTILE_SOLVER_BASE_URL:-}" ]]; then
  tmp_config="/tmp/config.runtime.json"
  node -e '
const fs = require("fs");
const src = process.argv[1];
const dst = process.argv[2];
const solver = process.argv[3];
const config = JSON.parse(fs.readFileSync(src, "utf8"));
config.turnstile ||= {};
config.turnstile.solverBaseUrl = solver;
fs.writeFileSync(dst, JSON.stringify(config, null, 2));
' /app/config.json "$tmp_config" "$ALMMA_TURNSTILE_SOLVER_BASE_URL"
  config_path="$tmp_config"
else
  config_path="/app/config.json"
fi

/opt/venv/bin/python /solver/api_solver.py --browser_type chromium --thread 1 --lazy-browser &
solver_pid=$!

cleanup() {
  kill "$solver_pid" 2>/dev/null || true
}
trap cleanup EXIT

exec node /app/server.mjs --config "$config_path"
