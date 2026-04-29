#!/usr/bin/env bash
# Build & push the sessions-ai-web image to:
#   1. Docker Hub:  $DOCKERHUB_USER/sessions-ai-web
#   2. Aliyun ACR:  registry.cn-hangzhou.aliyuncs.com/$ACR_NAMESPACE/sessions-ai-web   (China mirror)
#
# Why both: Docker Hub is the global default (free for public images);
# Aliyun ACR personal edition is free and accessible from inside China
# without a VPN.
#
# Usage:
#   DOCKERHUB_USER=greywen ACR_NAMESPACE=greywen ACR_REGION=cn-hangzhou \
#     ./scripts/release-docker.sh                   # tag = git short sha + 'latest'
#   ./scripts/release-docker.sh v0.2.0              # explicit tag, also pushes 'latest'
#
# Pre-req:
#   docker login                                    # Docker Hub
#   docker login registry.cn-hangzhou.aliyuncs.com  # Aliyun ACR
#
# Multi-arch (amd64+arm64) build via buildx; falls back to single-arch if buildx unavailable.

set -euo pipefail

DOCKERHUB_USER="${DOCKERHUB_USER:-greywen}"
ACR_NAMESPACE="${ACR_NAMESPACE:-$DOCKERHUB_USER}"
ACR_REGION="${ACR_REGION:-cn-hangzhou}"
ACR_HOST="registry.${ACR_REGION}.aliyuncs.com"

REPO_HUB="${DOCKERHUB_USER}/sessions-ai-web"
REPO_ACR="${ACR_HOST}/${ACR_NAMESPACE}/sessions-ai-web"

VERSION_TAG="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log()  { printf "\033[36m[release]\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m[release]\033[0m %s\n" "$*"; }

log "Repos:"
log "  $REPO_HUB:$VERSION_TAG, $REPO_HUB:latest"
log "  $REPO_ACR:$VERSION_TAG, $REPO_ACR:latest"
log "Platforms: $PLATFORMS"

if docker buildx version >/dev/null 2>&1; then
  if ! docker buildx inspect sessions-ai-builder >/dev/null 2>&1; then
    docker buildx create --name sessions-ai-builder --use >/dev/null
  else
    docker buildx use sessions-ai-builder
  fi

  docker buildx build \
    --platform "$PLATFORMS" \
    -f apps/web/Dockerfile \
    -t "$REPO_HUB:$VERSION_TAG" \
    -t "$REPO_HUB:latest" \
    -t "$REPO_ACR:$VERSION_TAG" \
    -t "$REPO_ACR:latest" \
    --push \
    .
else
  log "buildx not available, falling back to single-arch local build + push"
  docker build -f apps/web/Dockerfile -t "$REPO_HUB:$VERSION_TAG" .
  docker tag "$REPO_HUB:$VERSION_TAG" "$REPO_HUB:latest"
  docker tag "$REPO_HUB:$VERSION_TAG" "$REPO_ACR:$VERSION_TAG"
  docker tag "$REPO_HUB:$VERSION_TAG" "$REPO_ACR:latest"
  docker push "$REPO_HUB:$VERSION_TAG"
  docker push "$REPO_HUB:latest"
  docker push "$REPO_ACR:$VERSION_TAG"
  docker push "$REPO_ACR:latest"
fi

ok "✅ Pushed sessions-ai-web:$VERSION_TAG to Docker Hub + Aliyun ACR."
