#!/usr/bin/env bash
# setup.sh — 100X bootstrap for Jetson Orin Nano (Ubuntu 22.04 / JetPack 6)
# Idempotent: safe to run multiple times.
# Usage: sudo bash setup.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/100x"
THOTH_DB_DIR="/var/lib/thoth"
OLLAMA_BIN="/usr/local/bin/ollama"
NODE_MAJOR=20

log() { echo "[100X] $*"; }
die() { echo "[100X] ERROR: $*" >&2; exit 1; }

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash setup.sh"

# ── 1. System dependencies ────────────────────────────────────────────────────
log "Installing system dependencies..."
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl git ca-certificates gnupg sqlite3 build-essential python3

# Node 20 via NodeSource
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}"; then
  log "Installing Node ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

# ── 2. Claude Code CLI ────────────────────────────────────────────────────────
log "Installing Claude Code CLI..."
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi
claude --version

# ── 3. Ollama ─────────────────────────────────────────────────────────────────
log "Installing Ollama..."
if [[ ! -x "$OLLAMA_BIN" ]]; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
ollama --version

# Create dedicated ollama user/group if absent
if ! id ollama &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home /var/lib/ollama ollama
  mkdir -p /var/lib/ollama
  chown ollama:ollama /var/lib/ollama
fi

# Start Ollama temporarily to pull models
log "Pulling Ollama models (this may take a while)..."
if ! systemctl is-active --quiet ollama-100x 2>/dev/null; then
  sudo -u ollama ollama serve &>/tmp/ollama-setup.log &
  OLLAMA_PID=$!
  sleep 5
  PULL_STOP_OLLAMA=true
else
  PULL_STOP_OLLAMA=false
fi

sudo -u ollama ollama pull gemma4:e4b        || log "WARN: gemma4:e4b pull failed — retry manually"
sudo -u ollama ollama pull nomic-embed-text  || log "WARN: nomic-embed-text pull failed — retry manually"

if [[ "${PULL_STOP_OLLAMA:-false}" == "true" ]]; then
  kill "$OLLAMA_PID" 2>/dev/null || true
fi

# ── 4. Thoth MCP server ───────────────────────────────────────────────────────
log "Installing Thoth MCP server..."
mkdir -p "$INSTALL_DIR"
cp -r "$REPO_DIR/thoth-mcp" "$INSTALL_DIR/thoth-mcp"

cd "$INSTALL_DIR/thoth-mcp"
npm ci --prefer-offline
npm run build

# Create thoth user + DB dir
if ! id thoth &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home "$THOTH_DB_DIR" thoth
fi
mkdir -p "$THOTH_DB_DIR"
chown thoth:thoth "$THOTH_DB_DIR"
chmod 750 "$THOTH_DB_DIR"

# ── 5. Systemd services ───────────────────────────────────────────────────────
log "Installing systemd services..."

cp "$REPO_DIR/systemd/ollama-100x.service" /etc/systemd/system/
cp "$REPO_DIR/systemd/thoth-mcp.service"   /etc/systemd/system/

systemctl daemon-reload

systemctl enable --now ollama-100x.service
systemctl enable --now thoth-mcp.service

# ── 6. Claude Code MCP config ─────────────────────────────────────────────────
log "Writing Claude Code MCP config..."
CLAUDE_CONFIG_DIR="$HOME/.claude"
mkdir -p "$CLAUDE_CONFIG_DIR"

cat > "$CLAUDE_CONFIG_DIR/mcp_servers.json" <<'EOF'
{
  "mcpServers": {
    "thoth": {
      "command": "node",
      "args": ["/opt/100x/thoth-mcp/dist/index.js"],
      "env": {
        "THOTH_DB_PATH": "/var/lib/thoth/memory.db",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "EMBED_MODEL": "nomic-embed-text"
      }
    }
  }
}
EOF
log "MCP config written to $CLAUDE_CONFIG_DIR/mcp_servers.json"

# ── 7. Status ─────────────────────────────────────────────────────────────────
log "Checking service status..."
systemctl is-active ollama-100x.service && log "ollama-100x: running" || log "WARN: ollama-100x not running"
systemctl is-active thoth-mcp.service   && log "thoth-mcp: running"   || log "WARN: thoth-mcp not running"

log ""
log "100X setup complete."
log "Run 'claude' to start Claude Code — Thoth memory tools will be available."
log "Logs: journalctl -u thoth-mcp -u ollama-100x -f"
