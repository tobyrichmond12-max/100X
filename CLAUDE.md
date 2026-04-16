# 100X — Wearable AI Dev Pipeline

## Project Overview

100X is a wearable AI development pipeline running on a **Jetson Orin Nano** edge device. The goal is a self-contained, always-on coding assistant that combines:

- **Claude Code** (primary agentic interface) talking to a local MCP server for persistent memory
- **Thoth MCP Server** — a TypeScript MCP server exposing BM25 + vector hybrid memory to Claude Code
- **Ollama + Gemma 4 E4B** — local quantized LLM for fast, offline inference and embedding generation
- **Systemd services** — headless auto-start of all components on boot

The device is worn/carried; Claude Code connects to Thoth for project context, code snippets, and long-term memory that persists across sessions.

## Architecture

```
┌─────────────────────────────────────────────┐
│              Jetson Orin Nano                │
│                                             │
│  ┌──────────────┐     ┌───────────────────┐ │
│  │  Claude Code │────▶│   Thoth MCP       │ │
│  │  (agentic)   │◀────│   (BM25 + vector) │ │
│  └──────────────┘     └─────────┬─────────┘ │
│                                 │           │
│                       ┌─────────▼─────────┐ │
│                       │  Ollama + Gemma    │ │
│                       │  4 E4B (embeddings │ │
│                       │  + local inference)│ │
│                       └───────────────────┘ │
└─────────────────────────────────────────────┘
```

## Repository Layout

```
100X/
├── CLAUDE.md                   # This file
├── README.md
├── setup.sh                    # Jetson bootstrap (one-shot install)
├── thoth-mcp/                  # TypeScript MCP server
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # MCP server entry + tool registration
│       ├── memory/
│       │   ├── store.ts        # SQLite-backed document store
│       │   ├── bm25.ts         # BM25 keyword search
│       │   └── vector.ts       # Embedding + cosine similarity search
│       └── tools/
│           ├── remember.ts     # store_memory tool
│           └── recall.ts       # search_memory tool
├── systemd/
│   ├── thoth-mcp.service
│   └── ollama-100x.service
└── docs/
    └── architecture.md
```

## Key Components

### Thoth MCP Server

- Language: **TypeScript** (Node 20+)
- Transport: **stdio** (Claude Code default)
- Storage: **SQLite** via `better-sqlite3` — zero-dependency, runs on Jetson
- BM25: pure-TS implementation over tokenised document corpus
- Vector: float32 embeddings stored in SQLite blob, cosine similarity in JS (no external vector DB)
- Embedding model: pulled from Ollama (`nomic-embed-text` or Gemma embed endpoint)
- Tools exposed to Claude Code:
  - `store_memory(content, tags?, source?)` — chunk + embed + BM25-index a document
  - `search_memory(query, mode?, limit?)` — hybrid BM25 + vector retrieval, returns ranked chunks
  - `list_memories(tag?)` — list stored documents/tags
  - `delete_memory(id)` — remove a document

### setup.sh

Idempotent bootstrap for a fresh Jetson Orin Nano running Ubuntu 22.04 (JetPack 6):
1. System deps (Node 20, npm, curl, git, sqlite3)
2. Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
3. Ollama install + `ollama pull gemma4:e4b` + `ollama pull nomic-embed-text`
4. Thoth MCP server build (`npm ci && npm run build`)
5. Systemd service install + enable + start

### Systemd Services

- `ollama-100x.service` — runs `ollama serve`, `Restart=always`
- `thoth-mcp.service` — runs the compiled MCP server as a persistent stdio bridge via socket activation or socat

## Coding Preferences

### General

- **TypeScript strict mode** — `"strict": true` in tsconfig, no `any` unless unavoidable and commented
- Prefer **explicit return types** on all exported functions
- **No classes** unless the abstraction genuinely calls for it — prefer plain functions + closures
- Keep files **small and focused**: one responsibility per module
- **No unnecessary abstractions** — don't create helpers for one-off operations
- Avoid over-engineering: YAGNI applies hard here (embedded device, limited RAM)

### Error Handling

- Use **typed Result objects** (`{ ok: true, value } | { ok: false, error }`) over exceptions for expected failures
- Reserve `throw` for truly unrecoverable errors (bad config at startup)
- Log errors to stderr; structured JSON logs preferred (`{ level, msg, ts, ...ctx }`)

### Dependencies

- **Minimise dependencies** — Jetson has limited storage and slow installs
- Prefer zero-native-addon deps where possible; if native is needed, confirm ARM64/aarch64 builds exist
- Key allowed deps: `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`

### Testing

- Unit tests with **Vitest** (fast, ESM-native)
- Test file convention: `*.test.ts` co-located with source
- Focus tests on the BM25 scorer and vector similarity — the math must be correct

### Git

- Commit messages: imperative mood, present tense (`add BM25 scorer`, `fix embedding normalisation`)
- Small atomic commits; don't batch unrelated changes
- Branch: `claude/setup-100x-project-QgWSG`

## Environment Notes

- **Device**: Jetson Orin Nano (8 GB, aarch64, JetPack 6 / Ubuntu 22.04)
- **RAM budget**: Keep Node process under ~512 MB; SQLite DB under ~1 GB
- **No internet assumed at runtime** — all models pre-pulled; Ollama runs locally
- **Power**: device may lose power abruptly — SQLite WAL mode required, graceful shutdown on SIGTERM

## MCP Server Config (for CLAUDE.md / .claude/settings.json)

```json
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
```
