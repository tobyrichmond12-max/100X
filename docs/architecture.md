# Architecture

## Overview

100X is built around three processes that communicate locally on the Jetson:

1. **Claude Code** — the user-facing agentic CLI; connects to Thoth via MCP stdio transport
2. **Thoth MCP Server** — persistent memory layer; exposes hybrid search tools to Claude Code
3. **Ollama** — local model server; serves `nomic-embed-text` for embeddings and `gemma4:e4b` for inference

All three run as systemd services and restart automatically on failure or reboot.

## Data Flow: storing a memory

```
Claude Code
  └── calls store_memory(content, tags, source)
        └── Thoth MCP (index.ts)
              ├── insertDocument()  → SQLite documents table
              ├── indexDocument()   → SQLite bm25_terms table (TF per term)
              └── embed(content)    → POST /api/embeddings to Ollama
                    └── updateEmbedding() → SQLite documents.embedding BLOB
```

## Data Flow: searching memory

```
Claude Code
  └── calls search_memory(query, mode="hybrid", limit=5)
        └── Thoth MCP (index.ts)
              ├── bm25Search()    → SQL over bm25_terms, IDF × TF scoring
              ├── embed(query)    → Ollama embedding
              ├── vectorSearch()  → fetch all embeddings, cosine similarity
              └── rrfFuse()       → Reciprocal Rank Fusion → top-k doc IDs
                    └── getDocument() × k → returned to Claude Code
```

## SQLite Schema

```sql
documents (
  id         TEXT PRIMARY KEY,   -- UUID
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL,      -- JSON array
  source     TEXT,               -- file path, URL, etc.
  created_at INTEGER NOT NULL,   -- Unix ms
  embedding  BLOB                -- float32 little-endian
)

bm25_terms (
  doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  term   TEXT,
  freq   REAL,                   -- normalised term frequency
  PRIMARY KEY (doc_id, term)
)
```

WAL mode is enabled on every open — survives abrupt power loss.

## BM25 Implementation

Standard Okapi BM25 with k1=1.5, b=0.75.

- Terms are lower-cased, punctuation-stripped, split on whitespace
- TF is normalised by document length at index time and stored in `bm25_terms`
- IDF is computed at query time from corpus stats (no pre-computation needed at this scale)
- Scoring loop is pure JS — no native addon, no WASM

## Vector Implementation

- Embeddings are 768-dim float32 (nomic-embed-text) stored as raw binary blobs
- Similarity search is brute-force cosine — O(n) over all embedded documents
- Acceptable up to ~50 k docs on 8 GB Jetson; beyond that, consider HNSW via `hnswlib-node`
- RRF fusion (k=60) combines BM25 and vector ranked lists into a single score

## Systemd Services

```
ollama-100x.service
  User=ollama
  ExecStart=/usr/local/bin/ollama serve
  Restart=always

thoth-mcp.service
  User=thoth
  ExecStart=node /opt/100x/thoth-mcp/dist/index.js
  After=ollama-100x.service
  Restart=always
```

Thoth runs as a dedicated `thoth` user with write access only to `/var/lib/thoth`.

## Memory Budget

| Component | Typical RSS |
|-----------|-------------|
| Node (Thoth MCP) | ~80–150 MB |
| Ollama server | ~200 MB idle |
| nomic-embed-text model | ~300 MB VRAM |
| gemma4:e4b model | ~4–5 GB VRAM (quantised) |

Jetson Orin Nano has unified CPU/GPU memory (8 GB). Keep Node under 512 MB.

## Offline Operation

After initial setup (`setup.sh`) no outbound network is required:

- Ollama models are pre-pulled to `/var/lib/ollama`
- All embeddings and BM25 index live in SQLite on disk
- Claude Code API calls still require internet (Anthropic API) — this is expected
