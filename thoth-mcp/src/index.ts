/**
 * Thoth MCP Server — entry point.
 *
 * Registers four tools for Claude Code:
 *   store_memory    — chunk, BM25-index, embed, persist
 *   search_memory   — hybrid BM25+vector (degrades to BM25 if Ollama is down)
 *   list_memories   — enumerate stored docs, optionally filtered by tag
 *   delete_memory   — remove a doc by UUID
 *
 * Transport: stdio (Claude Code default).
 * Config:    environment variables (defaults suitable for local dev).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openStore } from "./memory/store.js";
import { StoreMemoryInput, storeMemory } from "./tools/remember.js";
import {
  SearchMemoryInput,
  ListMemoriesInput,
  DeleteMemoryInput,
  searchMemory,
  listMemories,
  deleteMemory,
} from "./tools/recall.js";

// ── Logging (defined first — used throughout module scope below) ──────────────

function log(
  level: "info" | "warn" | "error",
  msg: string,
  ctx: Record<string, unknown> = {}
): void {
  process.stderr.write(
    JSON.stringify({ level, msg, ts: Date.now(), ...ctx }) + "\n"
  );
}

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env["THOTH_DB_PATH"] ?? "/var/lib/thoth/memory.db";
const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
const EMBED_MODEL = process.env["EMBED_MODEL"] ?? "nomic-embed-text";

// ── DB ────────────────────────────────────────────────────────────────────────

const db = openStore(DB_PATH);

log("info", "thoth-mcp starting", {
  db: DB_PATH,
  ollama: OLLAMA_BASE_URL,
  model: EMBED_MODEL,
});

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "thoth", version: "0.1.0" });

// ── Tool: store_memory ────────────────────────────────────────────────────────

server.tool(
  "store_memory",
  "Persist text to long-term memory. Large documents are chunked automatically. " +
    "Each chunk is BM25-indexed and embedded for hybrid search. " +
    "Embedding is best-effort — the document is still searchable via BM25 if Ollama is unreachable.",
  StoreMemoryInput.shape,
  async (input) => {
    const parsed = StoreMemoryInput.safeParse(input);
    if (!parsed.success) {
      return errorContent(`Invalid input: ${parsed.error.message}`);
    }

    const result = await storeMemory(db, parsed.data, OLLAMA_BASE_URL, EMBED_MODEL);
    if (!result.ok) {
      log("error", "store_memory failed", { error: result.error });
      return errorContent(result.error);
    }

    return { content: [{ type: "text", text: result.value.message }] };
  }
);

// ── Tool: search_memory ───────────────────────────────────────────────────────

server.tool(
  "search_memory",
  "Search long-term memory. " +
    "mode=hybrid (default): BM25 + vector RRF, degrades to BM25-only if Ollama is unreachable. " +
    "mode=bm25: keyword search only. " +
    "mode=vector: semantic search only (fails if Ollama is unreachable).",
  SearchMemoryInput.shape,
  async (input) => {
    const parsed = SearchMemoryInput.safeParse(input);
    if (!parsed.success) {
      return errorContent(`Invalid input: ${parsed.error.message}`);
    }

    const result = await searchMemory(db, parsed.data, OLLAMA_BASE_URL, EMBED_MODEL);
    if (!result.ok) {
      log("error", "search_memory failed", { error: result.error });
      return errorContent(result.error);
    }

    if (result.value.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    const text = result.value
      .map(
        (r, i) =>
          `[${i + 1}] id=${r.id}  score=${r.score.toFixed(4)}` +
          (r.source ? `  source=${r.source}` : "") +
          (r.tags.length ? `  tags=${r.tags.join(",")}` : "") +
          `\n${r.content}`
      )
      .join("\n\n---\n\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: list_memories ───────────────────────────────────────────────────────

server.tool(
  "list_memories",
  "List stored memory documents. Optionally filter by tag. " +
    "Returns id, source, tags, and a 120-character preview for each document.",
  ListMemoriesInput.shape,
  (input) => {
    const parsed = ListMemoriesInput.safeParse(input);
    if (!parsed.success) {
      return errorContent(`Invalid input: ${parsed.error.message}`);
    }

    const result = listMemories(db, parsed.data);
    if (result.value.length === 0) {
      return { content: [{ type: "text", text: "No memories stored yet." }] };
    }

    const text = result.value
      .map(
        (m) =>
          `id=${m.id}` +
          (m.source ? `  source=${m.source}` : "") +
          (m.tags.length ? `  tags=${m.tags.join(",")}` : "") +
          `\n  ${m.preview}`
      )
      .join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: delete_memory ───────────────────────────────────────────────────────

server.tool(
  "delete_memory",
  "Permanently delete a memory document by its UUID.",
  DeleteMemoryInput.shape,
  (input) => {
    const parsed = DeleteMemoryInput.safeParse(input);
    if (!parsed.success) {
      return errorContent(`Invalid input: ${parsed.error.message}`);
    }

    const result = deleteMemory(db, parsed.data);
    if (!result.ok) {
      return errorContent(result.error);
    }

    return { content: [{ type: "text", text: `Deleted ${parsed.data.id}` }] };
  }
);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log("info", "shutting down", { signal });
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "thoth-mcp ready");

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorContent(msg: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}
