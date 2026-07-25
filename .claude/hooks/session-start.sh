#!/bin/bash
# SessionStart hook — prepares a Claude Code on the web container for this repo.
#
# NOTE ON WHAT THIS DOES *NOT* DO: there is nothing to install. backend/package.json
# declares no dependencies and no devDependencies on purpose — the server uses only
# Node built-ins (`http` + `node:sqlite`), which is why the repo has no
# node_modules and no package-lock.json. Running `npm install` here would be a
# no-op that generates a lockfile the project deliberately doesn't keep, so this
# hook verifies the prerequisites and sets up the environment instead.
set -euo pipefail

# Web sessions only — a local checkout already has whatever its owner set up.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# --- 1. Node version -------------------------------------------------------
# `npm test` (node --test) loads backend/db.js, which requires `node:sqlite`.
# That module exists from 22.5.0 but stays behind an experimental flag this
# project doesn't pass until 22.13.0, so an older Node fails the whole suite
# with an unhelpful module error. Surface it here instead.
REQUIRED_MAJOR=22
REQUIRED_MINOR=13
NODE_VERSION="$(node --version 2>/dev/null || echo 'none')"
if [ "$NODE_VERSION" = "none" ]; then
  echo "session-start: WARNING — node not found on PATH; backend tests will not run." >&2
else
  VER="${NODE_VERSION#v}"
  MAJOR="${VER%%.*}"
  REST="${VER#*.}"
  MINOR="${REST%%.*}"
  if [ "$MAJOR" -lt "$REQUIRED_MAJOR" ] || { [ "$MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$MINOR" -lt "$REQUIRED_MINOR" ]; }; then
    echo "session-start: WARNING — Node $NODE_VERSION is older than the required >=${REQUIRED_MAJOR}.${REQUIRED_MINOR}.0 (backend/package.json engines); node:sqlite will be unavailable and the test suite will fail." >&2
  else
    echo "session-start: Node $NODE_VERSION satisfies >=${REQUIRED_MAJOR}.${REQUIRED_MINOR}.0."
  fi
fi

# --- 2. Default database directory ----------------------------------------
# Without DARTS_DB set, backend/server.js writes to backend/../data/darts.db.
# Creating the directory up front keeps a first `node backend/server.js` from
# failing on a missing path. Harmless if it already exists; the DB file itself
# is created by the server.
mkdir -p data

# --- 3. Environment for verification scripts -------------------------------
# Playwright and its browsers live outside the repo in this image, so ad hoc
# verification scripts run from the scratchpad can't require('playwright')
# without being told where the global modules are. Persisting NODE_PATH here
# means they just work instead of every invocation needing it prefixed.
GLOBAL_NODE_MODULES="/opt/node22/lib/node_modules"
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -d "$GLOBAL_NODE_MODULES" ]; then
  # SessionStart also fires on resume/clear/compact, so the same env file can be
  # appended to several times in one session — write the export only once.
  if ! grep -qsF "NODE_PATH=\"$GLOBAL_NODE_MODULES\"" "$CLAUDE_ENV_FILE"; then
    echo "export NODE_PATH=\"$GLOBAL_NODE_MODULES\"" >> "$CLAUDE_ENV_FILE"
  fi
  echo "session-start: NODE_PATH set to $GLOBAL_NODE_MODULES for this session."
fi

# --- 4. Syntax check (this project's nearest thing to a linter) ------------
# There is no configured linter: no eslint/prettier config, no lint script, no
# CI lint step. (eslint happens to be on PATH in this image, but it refuses to
# run without an eslint.config.js, so it is not the project's tooling.)
# `node --check` needs no config or dependencies and catches the failure mode
# that actually bites here — a syntax error in a file the backend test suite
# never loads. Non-fatal: report, don't block.
SYNTAX_BAD=""
for f in backend/*.js frontend/*.js; do
  [ -e "$f" ] || continue
  node --check "$f" >/dev/null 2>&1 || SYNTAX_BAD="$SYNTAX_BAD $f"
done
if [ -n "$SYNTAX_BAD" ]; then
  echo "session-start: WARNING — syntax errors in:$SYNTAX_BAD" >&2
else
  echo "session-start: syntax check OK (node --check, all backend/ and frontend/ .js files)."
fi

# --- 5. Confirm the test runner actually works -----------------------------
# One small, fast suite rather than all 1305 tests — enough to prove node:sqlite
# loaded and the runner is usable, without adding ~25s to every session start.
# Never fatal: a failing project test is something to report, not a reason to
# block the session from starting.
if [ -f backend/test/db.non-savable-parity.test.js ]; then
  if (cd backend && node --test test/db.non-savable-parity.test.js >/dev/null 2>&1); then
    echo "session-start: test runner OK (backend/test/db.non-savable-parity.test.js)."
  else
    echo "session-start: WARNING — the sample backend test did not pass; run 'cd backend && npm test' to see why." >&2
  fi
fi

# The dev server is deliberately NOT started here. Every compose file in this
# repo keeps OCHE_REQUIRE_AUTH=true as a zero-trust default, and a hook that
# quietly launched it with auth disabled would contradict that in every future
# session. Start it explicitly when a session needs it, e.g.:
#   cd backend && OCHE_REQUIRE_AUTH=false node server.js
echo "session-start: ready."
