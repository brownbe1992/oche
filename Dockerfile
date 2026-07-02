# Darts scorer — single image that serves the app and the API.
# No npm install step: the backend uses only Node's built-in modules
# (http + node:sqlite), so there are no native dependencies to compile.
FROM node:22-alpine

# su-exec: a small static binary (Alpine's own package repo, not an npm/JS
# dependency) used only by docker-entrypoint.sh to drop from root to the non-root
# `node` user at container start — docs/security-audit-roadmap.md SEC-5.
RUN apk add --no-cache su-exec

WORKDIR /usr/src/app

# App code
COPY backend/  ./backend/
COPY frontend/ ./frontend/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The SQLite database lives here; mount a volume to keep it across restarts.
ENV DARTS_DB=/data/darts.db
ENV PORT=8046
RUN mkdir -p /data && chown -R node:node /usr/src/app /data
VOLUME ["/data"]

EXPOSE 8046
# Starts as root only to let docker-entrypoint.sh fix /data ownership, then execs the
# app as the non-root `node` user — see docker-entrypoint.sh and
# docs/security-audit-roadmap.md SEC-5. The app itself never runs any code as root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "backend/server.js"]
