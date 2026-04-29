#!/usr/bin/env bash
# Build & push the sessions-ai-web image to Docker Hub.
#
# Usage:
#   DOCKERHUB_USER=<your-dockerhub-user> ./scripts/release-docker.sh   # tag = git short sha + latest
#   ./scripts/release-docker.sh v0.2.0                        # explicit tag, also pushes latest
#   pnpm release:docker -- v0.2.0                             # pnpm form (leading "--" is ignored)
#   NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine pnpm release:docker -- v0.2.0
#
# Pre-req:
#   docker login
#
# Multi-arch (amd64+arm64) build via buildx; falls back to single-arch if buildx unavailable.

set -euo pipefail

# pnpm may forward a leading "--" to shell scripts.
if [ "${1:-}" = "--" ]; then
  shift
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log()  { printf "\033[36m[release]\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m[release]\033[0m %s\n" "$*"; }
die()  { printf "\033[31m[release]\033[0m %s\n" "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker not found. Install Docker first."
docker info >/dev/null 2>&1 || die "Docker daemon is not reachable. Start Docker Desktop / daemon first."

DOCKERHUB_USER="graywen"
if [ -z "$DOCKERHUB_USER" ]; then
  die "DOCKERHUB_USER is required. Example: DOCKERHUB_USER=<your-dockerhub-user> pnpm release:docker -- v0.1.0"
fi
if [[ "$DOCKERHUB_USER" == *"/"* ]]; then
  die "DOCKERHUB_USER should be namespace only (no slash), e.g. DOCKERHUB_USER=myname"
fi

REPO_HUB="${DOCKERHUB_USER}/sessions-ai-web"

VERSION_TAG="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}"
NODE_IMAGE_MIRROR_DEFAULT="${NODE_IMAGE_MIRROR_DEFAULT:-docker.m.daocloud.io/library/node:22-alpine}"

# If user did not explicitly override NODE_IMAGE, probe the official image path
# via Docker itself. On failure, switch to a mirror that is often accessible in CN.
if [ "$NODE_IMAGE" = "node:22-alpine" ]; then
  if docker buildx version >/dev/null 2>&1; then
    if ! docker buildx imagetools inspect node:22-alpine >/dev/null 2>&1; then
      log "docker.io probe failed; using mirror base image: $NODE_IMAGE_MIRROR_DEFAULT"
      NODE_IMAGE="$NODE_IMAGE_MIRROR_DEFAULT"
    fi
  elif command -v curl >/dev/null 2>&1; then
    if ! curl -fsS --connect-timeout 5 --max-time 12 \
      "https://auth.docker.io/token?scope=repository%3Alibrary%2Fnode%3Apull&service=registry.docker.io" \
      >/dev/null; then
      log "auth.docker.io unreachable; using mirror base image: $NODE_IMAGE_MIRROR_DEFAULT"
      NODE_IMAGE="$NODE_IMAGE_MIRROR_DEFAULT"
    fi
  fi
fi

log "Repos:"
log "  $REPO_HUB:$VERSION_TAG, $REPO_HUB:latest"
log "Platforms: $PLATFORMS"
log "Base image: $NODE_IMAGE"

if docker buildx version >/dev/null 2>&1; then
  if ! docker buildx inspect sessions-ai-builder >/dev/null 2>&1; then
    docker buildx create --name sessions-ai-builder --use >/dev/null
  else
    docker buildx use sessions-ai-builder
  fi

  docker buildx build \
    --platform "$PLATFORMS" \
    --build-arg NODE_IMAGE="$NODE_IMAGE" \
    -f apps/web/Dockerfile \
    -t "$REPO_HUB:$VERSION_TAG" \
    -t "$REPO_HUB:latest" \
    --push \
    .
else
  log "buildx not available, falling back to single-arch local build + push"
  DOCKER_BUILDKIT=1 docker build \
    --build-arg NODE_IMAGE="$NODE_IMAGE" \
    -f apps/web/Dockerfile \
    -t "$REPO_HUB:$VERSION_TAG" \
    .
  docker tag "$REPO_HUB:$VERSION_TAG" "$REPO_HUB:latest"
  docker push "$REPO_HUB:$VERSION_TAG"
  docker push "$REPO_HUB:latest"
fi

ok "Pushed sessions-ai-web:$VERSION_TAG to Docker Hub."
