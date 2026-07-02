#!/bin/sh
# docs/security-audit-roadmap.md SEC-5: the container starts as root only long enough
# to fix ownership of the (possibly host-bind-mounted) data directory, then drops to
# the non-root `node` user before running the app. A bind-mounted host directory is
# typically root-owned by default and Docker does not automatically re-own bind mounts
# the way it does named/anonymous volumes, so this keeps existing `./darts_data:/data`
# style deployments working without requiring every self-hoster to manually chown
# their data folder on upgrade, while the Node process itself never runs as root.
set -e

DATA_DIR="$(dirname "${DARTS_DB:-/data/darts.db}")"
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR" 2>/dev/null || true

exec su-exec node "$@"
