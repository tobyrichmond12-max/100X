#!/usr/bin/env bash
# setup.sh — 100X bootstrap for Jetson Orin Nano (Ubuntu 22.04 / JetPack 6)
#
# Idempotent: safe to re-run at any time. Each step checks current state
# before acting, so re-runs are fast and safe.
#
# Usage:
#   sudo bash setup.sh
#
# What it does:
#   1. System packages (curl, git, rsync, sqlite3, build-essential)
#   2. Node.js 20 via NodeSource (skipped if already at v20)
#   3. Claude Code CLI (skipped if already installed)
#   4. Ollama binary (skipped if already installed)
#   5. Ollama model pulls: gemma3:4b + nomic-embed-text
#   6. Thoth MCP server: sync sources → /opt/100x, npm install, tsc build
#   7. Systemd services: install unit files, daemon-reload, enable, start/restart
#   8. Claude Code MCP config → invoking user's ~/.claude/mcp_servers.json
#   9. Final status check

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/100x"
THOTH_DB_DIR="/var/lib/thoth"
OLLAMA_BIN="/usr/local/bin/ollama"
NODE_MAJOR=20

# gemma3:4b is the Ollama tag for the Gemma 3 4-billion-parameter model.
# It is the correct pull target for what this project calls "Gemma 4 E4B".
GEMMA_MODEL="gemma3:4b"
EMBED_MODEL="nomic-embed-text"

# ── Helpers ───────────────────────────────────────────────────────────────────

step()  { echo; printf '━━━  %s  ━━━\n' "$*"; }
log()   { echo "  →  $*"; }
ok()    { echo "  ✓  $*"; }
warn()  { echo "  ⚠  $*" >&2; }
die()   { echo "ERROR: $*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────────

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash setup.sh"

# Detect the invoking (non-root) user for writing config files.
# Falls back to root when run directly as root (not via sudo).
REAL_USER="${SUDO_USER:-root}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
[[ -d "$REAL_HOME" ]] || die "Cannot determine home directory for user '$REAL_USER'"

# ── 1. System packages ────────────────────────────────────────────────────────

step "System packages"
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl git ca-certificates gnupg sqlite3 build-essential python3-minimal rsync
ok "system packages ready"

# ── 2. Node.js ${NODE_MAJOR} ──────────────────────────────────────────────────

step "Node.js ${NODE_MAJOR}"

installed_major=""
if command -v node &>/dev/null; then
  installed_major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
fi

if [[ "$installed_major" != "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR} via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node.js ${NODE_MAJOR} already installed — skipping"
fi

ok "node $(node --version)  /  npm $(npm --version)"

# ── 3. Claude Code CLI ────────────────────────────────────────────────────────

step "Claude Code CLI"
if ! command -v claude &>/dev/null; then
  log "Installing @anthropic-ai/claude-code..."
  npm install -g @anthropic-ai/claude-code
else
  log "Claude Code already installed — skipping"
fi
ok "claude $(claude --version 2>/dev/null || echo '(installed)')"

# ── 4. Ollama binary ──────────────────────────────────────────────────────────

step "Ollama"
if [[ ! -x "$OLLAMA_BIN" ]]; then
  log "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
else
  log "Ollama already installed — skipping"
fi
ok "ollama $(ollama --version 2>/dev/null)"

# Ensure the ollama system user and data directory exist.
# Ollama's install.sh usually handles this; these checks make re-runs safe.
if ! id ollama &>/dev/null; then
  log "Creating ollama system user..."
  mkdir -p /var/lib/ollama
  useradd --system --shell /usr/sbin/nologin \
          --home-dir /var/lib/ollama --no-create-home ollama
fi
mkdir -p /var/lib/ollama
chown ollama:ollama /var/lib/ollama

# ── 5. Ollama model pulls ─────────────────────────────────────────────────────

step "Ollama models  ($GEMMA_MODEL  +  $EMBED_MODEL)"

# We need a live Ollama API endpoint to pull models.
# Prefer an already-running instance; otherwise start a temporary one.

is_ollama_api_up() {
  curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1
}

TEMP_OLLAMA_PID=""

stop_temp_ollama() {
  [[ -n "$TEMP_OLLAMA_PID" ]] || return 0
  log "Stopping temporary Ollama instance (pid $TEMP_OLLAMA_PID)..."
  kill "$TEMP_OLLAMA_PID" 2>/dev/null || true
  wait "$TEMP_OLLAMA_PID" 2>/dev/null || true
  TEMP_OLLAMA_PID=""
}
trap stop_temp_ollama EXIT INT TERM

if is_ollama_api_up; then
  log "Ollama API already reachable — using existing instance"
else
  log "Starting temporary Ollama for model pulls..."
  sudo -u ollama "$OLLAMA_BIN" serve >/tmp/ollama-setup.log 2>&1 &
  TEMP_OLLAMA_PID=$!

  log "Waiting for Ollama API (up to 30 s)..."
  ready=false
  for _ in $(seq 1 30); do
    if is_ollama_api_up; then
      ready=true
      break
    fi
    sleep 1
  done
  $ready || die "Ollama did not become ready in 30 s. Check /tmp/ollama-setup.log"
  log "Ollama API ready"
fi

# Pull models — idempotent: Ollama compares manifest digests and skips
# unchanged layers, so re-pulling an up-to-date model is fast.
pull_model() {
  local model="$1"
  log "Pulling $model (already-current = fast no-op)..."
  if sudo -u ollama "$OLLAMA_BIN" pull "$model"; then
    ok "$model ready"
  else
    warn "$model pull failed — service will still start; retry: ollama pull $model"
  fi
}

pull_model "$GEMMA_MODEL"
pull_model "$EMBED_MODEL"

stop_temp_ollama
trap - EXIT INT TERM

# ── 6. Thoth MCP server ───────────────────────────────────────────────────────

step "Thoth MCP server"

# Ensure thoth system user and DB directory exist.
if ! id thoth &>/dev/null; then
  log "Creating thoth system user..."
  mkdir -p "$THOTH_DB_DIR"
  useradd --system --shell /usr/sbin/nologin \
          --home-dir "$THOTH_DB_DIR" --no-create-home thoth
fi
mkdir -p "$THOTH_DB_DIR"
chown thoth:thoth "$THOTH_DB_DIR"
chmod 750 "$THOTH_DB_DIR"

# Sync sources to install directory.
# rsync --delete makes this idempotent and handles the source == dest case.
mkdir -p "$INSTALL_DIR"
if [[ "$(realpath "$REPO_DIR")" != "$(realpath "$INSTALL_DIR")" ]]; then
  log "Syncing thoth-mcp sources → $INSTALL_DIR/thoth-mcp..."
  rsync -a --delete \
    --exclude=node_modules \
    --exclude=dist \
    --exclude='*.db' \
    "$REPO_DIR/thoth-mcp/" "$INSTALL_DIR/thoth-mcp/"
else
  log "Source and install dirs are the same — skipping rsync"
fi

# Build in a subshell so the cd does not affect the parent shell.
(
  cd "$INSTALL_DIR/thoth-mcp"

  log "Installing npm dependencies..."
  if [[ -f package-lock.json ]]; then
    # Reproducible install from lock file
    npm ci --prefer-offline
  else
    # No lock file yet (first run from fresh clone without one committed)
    npm install
  fi

  log "Compiling TypeScript..."
  npm run build
)

ok "thoth-mcp built → $INSTALL_DIR/thoth-mcp/dist/index.js"

# ── 7. Systemd services ───────────────────────────────────────────────────────

step "Systemd services"

install_unit() {
  local name="$1"
  local src="$REPO_DIR/systemd/${name}.service"
  local dest="/etc/systemd/system/${name}.service"
  [[ -f "$src" ]] || die "Unit file not found: $src"
  cp "$src" "$dest"
  log "Installed $dest"
}

install_unit "ollama-100x"
install_unit "thoth-mcp"
systemctl daemon-reload

# Enable + start-or-restart each service.
# `enable --now` only starts if stopped; explicit restart picks up new unit files.
for svc in ollama-100x thoth-mcp; do
  systemctl enable "${svc}.service" >/dev/null
  if systemctl is-active --quiet "${svc}.service"; then
    log "Restarting ${svc} (was already running)..."
    systemctl restart "${svc}.service"
  else
    log "Starting ${svc}..."
    systemctl start "${svc}.service"
  fi
done

# ── 8. Claude Code MCP config ─────────────────────────────────────────────────

step "Claude Code MCP config"

CLAUDE_CONFIG_DIR="$REAL_HOME/.claude"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Write config with actual install paths substituted in.
cat > "$CLAUDE_CONFIG_DIR/mcp_servers.json" <<EOF
{
  "mcpServers": {
    "thoth": {
      "command": "node",
      "args": ["$INSTALL_DIR/thoth-mcp/dist/index.js"],
      "env": {
        "THOTH_DB_PATH": "$THOTH_DB_DIR/memory.db",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "EMBED_MODEL": "$EMBED_MODEL"
      }
    }
  }
}
EOF

chown -R "${REAL_USER}:${REAL_USER}" "$CLAUDE_CONFIG_DIR"
ok "MCP config → $CLAUDE_CONFIG_DIR/mcp_servers.json"

# ── 9. Status ─────────────────────────────────────────────────────────────────

step "Status"

# Give services a moment to settle after start/restart.
sleep 2

failures=0
for svc in ollama-100x thoth-mcp; do
  state="$(systemctl is-active "${svc}.service" 2>/dev/null || true)"
  if [[ "$state" == "active" ]]; then
    ok "${svc}: active (running)"
  else
    warn "${svc}: ${state:-unknown}"
    warn "  → journalctl -u ${svc} --no-pager -n 30"
    failures=$(( failures + 1 ))
  fi
done

echo
if [[ $failures -eq 0 ]]; then
  cat <<'MSG'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  100X setup complete.

  Run:   claude
  Thoth memory tools are wired in automatically.

  Logs:  journalctl -u thoth-mcp -u ollama-100x -f
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MSG
else
  cat <<'MSG'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  100X setup finished with warnings.
  One or more services failed to start.

  Diagnose:
    journalctl -u thoth-mcp -u ollama-100x -n 50 --no-pager

  Re-run this script after fixing the issue:
    sudo bash setup.sh
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MSG
  exit 1
fi
