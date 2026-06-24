# Darts scorer — single image that serves the app and the API.
# No npm install step: the backend uses only Node's built-in modules
# (http + node:sqlite), so there are no native dependencies to compile.
FROM node:22-alpine

WORKDIR /usr/src/app

# App code
COPY backend/  ./backend/
COPY frontend/ ./frontend/

# The SQLite database lives here; mount a volume to keep it across restarts.
ENV DARTS_DB=/data/darts.db
ENV PORT=8046
VOLUME ["/data"]

EXPOSE 8046
CMD ["node", "backend/server.js"]
