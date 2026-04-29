#!/usr/bin/env bash
# sessions-ai Agent — macOS / Linux one-click installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-agent.sh | bash
#   curl -fsSL .../install-agent.sh | bash -s -- --server-url http://your-host:23712
#   ./scripts/install-agent.sh --server-url http://your-host:23712 [--no-service]
#
# Steps:
#   1. Install Bun if missing
#   2. Install Node + npm if missing (Linux: apt/dnf/pacman/zypper; macOS: Homebrew)
#   3. npm i -g sessions-ai
#   4. Optionally:  sessions-ai config set serverUrl <url>
#   5. sessions-ai service install   (launchd on macOS, systemd --user on Linux)

set -euo pipefail

SERVER_URL=""
NO_SERVICE=0
for arg in "$@"; do
  case "$arg" in
    --server-url=*) SERVER_URL="${arg#--server-url=}" ;;
    --server-url)   shift; SERVER_URL="${1:-}";;
    --no-service)   NO_SERVICE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
  esac
done

log()  { printf "\033[36m[sessions-ai]\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m[sessions-ai]\033[0m %s\n" "$*"; }
warn() { printf "\033[33m[sessions-ai]\033[0m %s\n" "$*"; }
die()  { printf "\033[31m[sessions-ai]\033[0m %s\n" "$*" >&2; exit 1; }

OS="$(uname -s)"

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    ok "Bun present: $(bun --version)"
    return
  fi
  log "Installing Bun (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun install failed"
}

ensure_node() {
  if command -v npm >/dev/null 2>&1; then return; fi
  case "$OS" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        log "Installing Node via Homebrew..."
        brew install node
      else
        die "Install Homebrew first (https://brew.sh) or install Node manually."
      fi
      ;;
    Linux)
      if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y nodejs npm
      elif command -v dnf      >/dev/null 2>&1; then sudo dnf install -y nodejs npm
      elif command -v pacman   >/dev/null 2>&1; then sudo pacman -Sy --noconfirm nodejs npm
      elif command -v zypper   >/dev/null 2>&1; then sudo zypper install -y nodejs npm
      else die "No supported package manager. Install Node.js manually from https://nodejs.org"
      fi
      ;;
    *) die "Unsupported OS: $OS" ;;
  esac
}

install_pkg() {
  log "Installing sessions-ai globally via npm..."
  if [ "$(id -u 2>/dev/null || echo 0)" = "0" ] || [ "$OS" != "Linux" ]; then
    npm install -g sessions-ai
  else
    # Avoid sudo for npm prefix in user dir; otherwise fall back to sudo.
    if npm config get prefix | grep -qE "^$HOME"; then
      npm install -g sessions-ai
    else
      sudo npm install -g sessions-ai
    fi
  fi
}

main() {
  log "== sessions-ai Agent installer ($OS) =="
  ensure_bun
  ensure_node
  install_pkg

  if [ -n "$SERVER_URL" ]; then
    log "Setting serverUrl = $SERVER_URL"
    sessions-ai config set serverUrl "$SERVER_URL"
  fi

  if [ "$NO_SERVICE" -eq 0 ]; then
    log "Installing autostart service..."
    sessions-ai service install
    if [ "$OS" = "Linux" ]; then
      warn "On Linux, run once if you want it to keep running after logout:"
      warn "    sudo loginctl enable-linger \"$USER\""
    fi
  else
    warn "--no-service specified, skipping service install."
  fi

  ok "✅ sessions-ai Agent installed."
  ok "   Manage: sessions-ai service uninstall | sessions-ai config show"
}

main "$@"
