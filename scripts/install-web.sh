#!/usr/bin/env bash
# sessions-ai Web — Docker Compose one-click installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-web.sh | bash
#   ./scripts/install-web.sh [--dir /opt/sessions-ai] [--port 23712] [--image-source dockerhub|local]
#
# What it does:
#   1. Downloads docker-compose.yml + .env template into target dir
#   2. Generates random JWT_SECRET / passwords if not set
#   3. docker compose up -d
#
# Image sources:
#   dockerhub  → graywen/sessions-ai-web:latest         (default, requires Docker Hub access)
#   local      → builds from local repo checkout (must run inside cloned repo)

set -euo pipefail

TARGET_DIR="${HOME}/sessions-ai-web"
WEB_PORT=23712
IMAGE_SOURCE="dockerhub"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          TARGET_DIR="$2"; shift 2 ;;
    --dir=*)        TARGET_DIR="${1#--dir=}"; shift ;;
    --port)         WEB_PORT="$2"; shift 2 ;;
    --port=*)       WEB_PORT="${1#--port=}"; shift ;;
    --image-source) IMAGE_SOURCE="$2"; shift 2 ;;
    --image-source=*) IMAGE_SOURCE="${1#--image-source=}"; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf "\033[36m[sessions-ai]\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m[sessions-ai]\033[0m %s\n" "$*"; }
die()  { printf "\033[31m[sessions-ai]\033[0m %s\n" "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker not found. Install Docker first: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin required."

case "$IMAGE_SOURCE" in
  dockerhub) IMAGE="graywen/sessions-ai-web:latest" ;;
  local)     IMAGE="" ;;
  *) die "--image-source must be one of: dockerhub, local" ;;
esac

mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

# Generate strong secrets only on first install
if [ ! -f .env ]; then
  log "Generating .env at $TARGET_DIR/.env"
  rand() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | xxd -p -c "$1"; }
  cat > .env <<EOF
POSTGRES_USER=sessions
POSTGRES_PASSWORD=$(rand 16)
POSTGRES_DB=sessions_ai
WEB_PORT=${WEB_PORT}
JWT_SECRET=$(rand 32)
ADMIN_EMAIL=admin
ADMIN_PASSWORD=$(rand 8)
LOG_LEVEL=info
OPENROUTER_MODELS_URL=https://openrouter.ai/api/v1/models
EOF
  ok "Generated .env (admin password is randomized — see file)."
else
  log ".env already exists, keeping it."
fi

if [ "$IMAGE_SOURCE" = "local" ]; then
  log "Using local build from current repo. Make sure you are in the cloned sessions-ai monorepo."
  COMPOSE_FILE="apps/web/docker-compose.yml"
  [ -f "$COMPOSE_FILE" ] || die "Cannot find $COMPOSE_FILE — run from monorepo root or use --image-source dockerhub"
  docker compose -f "$COMPOSE_FILE" --env-file "$TARGET_DIR/.env" up -d --build
else
  log "Downloading SQL migrations into ./drizzle/ ..."
  mkdir -p drizzle
  RAW_BASE="https://raw.githubusercontent.com/greywen/sessions-ai/main/apps/web/drizzle"
  for f in 0000_init.sql 0001_black_triton.sql 0002_materialize_message_cost.sql 0003_brown_lockjaw.sql 0004_session_message_favorites.sql; do
    if [ ! -f "drizzle/$f" ]; then
      log "  fetch $f"
      curl -fsSL "$RAW_BASE/$f" -o "drizzle/$f"
    fi
  done

  log "Writing docker-compose.yml using image: $IMAGE"
  cat > docker-compose.yml <<EOF
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - sessions_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 20

  migrate:
    image: postgres:17-alpine
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      PGPASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - ./drizzle:/migrations:ro
    entrypoint:
      - sh
      - -c
      - |
        set -e
        psql -h postgres -U \${POSTGRES_USER} -d \${POSTGRES_DB} -v ON_ERROR_STOP=1 \\
          -c "CREATE TABLE IF NOT EXISTS _schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        for f in /migrations/*.sql; do
          [ -f "\$\$f" ] || continue
          name=\$\$(basename "\$\$f")
          safe=\$\$(printf "%s" "\$\$name" | sed "s/'/''/g")
          done_=\$\$(psql -h postgres -U \${POSTGRES_USER} -d \${POSTGRES_DB} -tA -v ON_ERROR_STOP=1 \\
            -c "SELECT 1 FROM _schema_migrations WHERE filename = '\$\$safe' LIMIT 1")
          if [ "\$\$done_" = "1" ]; then echo "Skip \$\$name"; continue; fi
          echo "Apply \$\$name"
          psql -h postgres -U \${POSTGRES_USER} -d \${POSTGRES_DB} -v ON_ERROR_STOP=1 -f "\$\$f"
          psql -h postgres -U \${POSTGRES_USER} -d \${POSTGRES_DB} -v ON_ERROR_STOP=1 \\
            -c "INSERT INTO _schema_migrations (filename) VALUES ('\$\$safe')"
        done
    restart: "no"

  web:
    image: ${IMAGE}
    pull_policy: always
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB}
      JWT_SECRET: \${JWT_SECRET}
      ADMIN_EMAIL: \${ADMIN_EMAIL}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      LOG_LEVEL: \${LOG_LEVEL}
      OPENROUTER_MODELS_URL: \${OPENROUTER_MODELS_URL}
    ports:
      - "\${WEB_PORT}:23712"

volumes:
  sessions_pg_data:
EOF
  docker compose --env-file "$TARGET_DIR/.env" up -d
fi

ok "✅ Web stack started."
ok "   URL:        http://localhost:${WEB_PORT}"
ok "   Admin:      $(grep ^ADMIN_EMAIL .env | cut -d= -f2)  /  see ADMIN_PASSWORD in $TARGET_DIR/.env"
ok "   Stop:       (cd $TARGET_DIR && docker compose down)"
ok "   Logs:       (cd $TARGET_DIR && docker compose logs -f web)"
