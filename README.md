# 100X — Wearable AI Dev Pipeline

Always-on coding assistant on a **Jetson Orin Nano**: Claude Code + persistent memory (Thoth MCP) + local inference (Ollama).

---

## Quick Start

**Requirements:** Jetson Orin Nano 8 GB · JetPack 6 / Ubuntu 22.04 · internet for first run only

```bash
git clone https://github.com/tobyrichmond12-max/100X.git
cd 100X
sudo bash setup.sh        # ~10 min first run (model pulls)
```

`setup.sh` is idempotent — re-run it safely after `git pull` to apply updates.

Once setup completes, start Claude Code:

```bash
claude
```

Thoth memory tools are wired in automatically. Run `/mcp` inside Claude Code to confirm the `thoth` server is listed.

---

## Services

| Service | Listens on | Log | Restart |
|---------|-----------|-----|---------|
| `ollama-100x` | `127.0.0.1:11434` | `journalctl -u ollama-100x -f` | `systemctl restart ollama-100x` |
| `thoth-mcp` | stdio only | `journalctl -u thoth-mcp -o cat -f` | `systemctl restart thoth-mcp` |

Both services start at boot and restart on failure. Check status together:

```bash
systemctl status ollama-100x thoth-mcp
```

---

## MCP Tools

All four tools are available to Claude Code when Thoth is connected.

### `store_memory`

Stores text in persistent memory. Large documents are split into ~512-token chunks. Each chunk is BM25-indexed and embedded. Embedding is best-effort — the chunk is still keyword-searchable if Ollama is unreachable.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `content` | `string` | ✓ | Text to store |
| `tags` | `string[]` | | Filter labels, e.g. `["project:foo", "lang:ts"]` |
| `source` | `string` | | Provenance: file path, URL, ticket ID |

**Returns:** stored document ID(s) and per-chunk embedding status.

---

### `search_memory`

Searches stored memory. Default mode fuses BM25 and vector results via Reciprocal Rank Fusion. Degrades to BM25-only automatically if Ollama is unreachable.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | — | Search query |
| `mode` | `"hybrid"` \| `"bm25"` \| `"vector"` | `"hybrid"` | `hybrid` never hard-fails; `vector` errors if Ollama is down |
| `limit` | `number` (1–50) | `5` | Max results to return |

**Returns:** ranked list — each item has `id`, `content`, `tags`, `source`, `score`.

---

### `list_memories`

Lists stored documents, newest first.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tag` | `string` | Optional — filter to documents with this tag |

**Returns:** `id`, `source`, `tags`, and a 120-character preview per document.

---

### `delete_memory`

Permanently removes a document and its BM25 index entries.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` (UUID) | Document ID to delete |

---

## Development

```bash
cd thoth-mcp
npm install          # install deps (generates package-lock.json on first run)
npm run build        # tsc → dist/
npm test             # vitest — BM25 scoring math + vector similarity
npm run dev          # tsc --watch
```

### Run the MCP server locally

Useful for seeing raw structured-JSON logs and catching startup errors before deploying via systemd:

```bash
THOTH_DB_PATH=/tmp/test-thoth.db \
OLLAMA_BASE_URL=http://localhost:11434 \
EMBED_MODEL=nomic-embed-text \
node dist/index.js
```

The server blocks on stdin (MCP stdio transport). Logs appear on stderr. `Ctrl-C` exits cleanly.

### Test against Claude Code

`setup.sh` writes `~/.claude/mcp_servers.json` pointing at the production install. To test a local dev build instead, override the path:

```bash
# ~/.claude/mcp_servers.json  (edit temporarily)
{
  "mcpServers": {
    "thoth": {
      "command": "node",
      "args": ["/home/YOU/100X/thoth-mcp/dist/index.js"],
      "env": {
        "THOTH_DB_PATH": "/tmp/test-thoth.db",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "EMBED_MODEL": "nomic-embed-text"
      }
    }
  }
}
```

Start Claude Code and run `/mcp` — `thoth` should appear with all four tools.

---

## Troubleshooting

### Ollama not responding

```bash
# 1. Service state
systemctl status ollama-100x

# 2. API reachable?
curl -s http://localhost:11434/api/tags | python3 -m json.tool

# 3. OOM-killed or GPU error?
journalctl -u ollama-100x --no-pager -n 50 | grep -iE 'kill|oom|error|failed'

# 4. Jetson power mode (low-power modes throttle the GPU)
nvpmodel -q
sudo nvpmodel -m 0    # max performance mode

# 5. Restart
systemctl restart ollama-100x
```

If the service fails to stay up, check `dmesg | grep -i nvhost` for GPU driver errors. Ensure the device has finished booting fully before the service starts (`After=network-online.target` handles the common race).

---

### MCP server not registering with Claude Code

```bash
# 1. Config exists and is valid JSON?
cat ~/.claude/mcp_servers.json | python3 -m json.tool

# 2. Built dist present?
ls -lh /opt/100x/thoth-mcp/dist/index.js

# 3. Run by hand — startup errors print to stderr
node /opt/100x/thoth-mcp/dist/index.js

# 4. DB directory ownership
ls -la /var/lib/thoth/
# Must be:  drwx------ thoth thoth
```

Inside Claude Code, `/mcp` lists connected servers and their tool registrations. If `thoth` is absent, restart Claude Code after fixing the config — it reads `mcp_servers.json` at startup.

---

### Systemd service failing to start or crashlooping

```bash
# Quick summary + last lines
systemctl status thoth-mcp

# Full recent log
journalctl -u thoth-mcp --no-pager -n 80

# If the restart burst limit was hit, reset and retry
systemctl reset-failed thoth-mcp
systemctl start thoth-mcp
```

Common root causes:

| Symptom | Check | Fix |
|---------|-------|-----|
| `No such file: dist/index.js` | `ls /opt/100x/thoth-mcp/dist/` | Re-run `setup.sh` or `npm run build` |
| `EACCES /var/lib/thoth` | `ls -la /var/lib/thoth` | `chown thoth:thoth /var/lib/thoth` |
| `Cannot find module` | Node version | `node --version` must be v20+ |
| `/usr/bin/node: not found` | Node install path | `which node`; update `ExecStart` in service file |
| Exits immediately, code 0 | stdio closed | Normal if run outside MCP; check real logs via `journalctl` |

---

## Architecture

```
Claude Code ──stdio──▶ Thoth MCP
                            │
               ┌────────────┴────────────┐
           BM25 index             float32 vectors
         (SQLite bm25_terms)    (SQLite BLOBs · cosine)
               └────────────┬────────────┘
                         Ollama
                   127.0.0.1:11434
            gemma3:4b  ·  nomic-embed-text
```

Data flows, SQL schema, BM25/RRF implementation notes, and memory budget: **[docs/architecture.md](docs/architecture.md)**

---

## Requirements

| | |
|-|-|
| Hardware | Jetson Orin Nano 8 GB (aarch64) |
| OS | Ubuntu 22.04 / JetPack 6 |
| Disk | ≥ 8 GB free (models ~6 GB, DB grows with usage) |
| Network | Internet for `setup.sh` only; fully offline at runtime |
