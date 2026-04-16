# 100X — Wearable AI Dev Pipeline

A self-contained, always-on coding assistant that runs on a **Jetson Orin Nano** edge device. Combines Claude Code with a local persistent memory layer (Thoth MCP) and local LLM inference (Ollama + Gemma 4 E4B).

## Quick Start

```bash
# On a fresh Jetson Orin Nano (JetPack 6 / Ubuntu 22.04)
git clone https://github.com/tobyrichmond12-max/100X.git
cd 100X
sudo bash setup.sh
```

Then start Claude Code — the `thoth` MCP server is automatically wired in:

```bash
claude
```

## What's Inside

| Component | Description |
|-----------|-------------|
| **Thoth MCP** | TypeScript MCP server; exposes `store_memory`, `search_memory`, `list_memories`, `delete_memory` to Claude Code |
| **BM25 search** | Pure-TS keyword retrieval indexed into SQLite |
| **Vector search** | Float32 embeddings via Ollama, cosine similarity in JS |
| **Hybrid mode** | Reciprocal Rank Fusion (RRF) combines BM25 + vector results |
| **setup.sh** | Idempotent one-shot bootstrap: Node 20, Claude Code CLI, Ollama, model pulls, systemd services |

## Memory Tools (Claude Code)

```
store_memory(content, tags?, source?)   — save a document
search_memory(query, mode?, limit?)     — hybrid/bm25/vector search
list_memories(tag?)                     — list all stored docs
delete_memory(id)                       — remove a doc by ID
```

## Architecture

```
Claude Code ──stdio──▶ Thoth MCP Server
                              │
                    ┌─────────┴──────────┐
                    │                    │
               BM25 index          Vector index
               (SQLite)         (SQLite float32 blobs)
                    │                    │
                    └────── Ollama ───────┘
                       nomic-embed-text / Gemma 4 E4B
```

See [docs/architecture.md](docs/architecture.md) for full details.

## Services

Both services auto-start on boot via systemd:

```bash
systemctl status ollama-100x   # Ollama LLM server
systemctl status thoth-mcp     # Thoth memory server

# Logs
journalctl -u thoth-mcp -u ollama-100x -f
```

## Development

```bash
cd thoth-mcp
npm ci
npm run dev        # TypeScript watch mode
npm test           # Vitest unit tests
```

## Requirements

- Jetson Orin Nano 8 GB (aarch64, JetPack 6 / Ubuntu 22.04)
- ~6 GB free disk (Ollama models)
- Node 20+
- Internet access for initial setup only (models pre-pulled; offline at runtime)
