/**
 * Thoth MCP Server — entry point.
 * Registers store_memory, search_memory, list_memories, delete_memory tools.
 * Transport: stdio (Claude Code default).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openStore } from "./memory/store.js";
import {
  StoreMemoryInput,
  storeMemory,
} from "./tools/remember.js";
import {
  SearchMemoryInput,
  ListMemoriesInput,
  DeleteMemoryInput,
  searchMemory,
  listMemories,
  deleteMemory,
} from "./tools/recall.js";

// ── Config from environment ───────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const DB_PATH = process.env["THOTH_DB_PATH"] ?? "/var/lib/thoth/memory.db";
const OLLAMA_BASE_URL =
  process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
const EMBED_MODEL = process.env["EMBED_MODEL"] ?? "nomic-embed-text";

// ── Boot ──────────────────────────────────────────────────────────────────────

const db = openStore(DB_PATH);

log("info", "thoth-mcp starting", {
  db: DB_PATH,
  ollama: OLLAMA_BASE_URL,
  model: EMBED_MODEL,
});

const server = new McpServer({
  name: "thoth",
  version: "0.1.0",
});

// ── Tool: store_memory ────────────────────────────────────────────────────────

server.tool(
  "store_memory",
  "Store a piece of text in persistent memory. Chunks large documents automatically and generates embeddings for semantic search.",
  StoreMemoryInput.shape,
  async (input) => {
    const parsed = StoreMemoryInput.safeParse(input);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const result = await storeMemory(db, parsed.data, OLLAMA_BASE_URL, EMBED_MODEL);

    if (!result.ok) {
      log("error", "store_memory failed", { error: result.error });
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.value.message }],
    };
  }
);

// ── Tool: search_memory ───────────────────────────────────────────────────────

server.tool(
  "search_memory",
  "Search persistent memory using BM25 keyword search, vector semantic search, or a hybrid of both (default). Returns ranked results.",
  SearchMemoryInput.shape,
  async (input) => {
    const parsed = SearchMemoryInput.safeParse(input);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const result = await searchMemory(
      db,
      parsed.data,
      OLLAMA_BASE_URL,
      EMBED_MODEL
    );

    if (!result.ok) {
      log("error", "search_memory failed", { error: result.error });
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    if (result.value.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    const text = result.value
      .map(
        (r, i) =>
          `[${i + 1}] id=${r.id} score=${r.score.toFixed(4)}` +
          (r.source ? ` source=${r.source}` : "") +
          (r.tags.length ? ` tags=${r.tags.join(",")}` : "") +
          `\n${r.content}`
      )
      .join("\n\n---\n\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: list_memories ───────────────────────────────────────────────────────

server.tool(
  "list_memories",
  "List all stored memories, optionally filtered by tag. Returns id, source, tags, and a short preview of each.",
  ListMemoriesInput.shape,
  (input) => {
    const parsed = ListMemoriesInput.safeParse(input);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const result = listMemories(db, parsed.data);
    if (result.value.length === 0) {
      return { content: [{ type: "text", text: "No memories stored yet." }] };
    }

    const text = result.value
      .map(
        (m) =>
          `id=${m.id}` +
          (m.source ? ` source=${m.source}` : "") +
          (m.tags.length ? ` tags=${m.tags.join(",")}` : "") +
          `\n  ${m.preview}`
      )
      .join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: delete_memory ───────────────────────────────────────────────────────

server.tool(
  "delete_memory",
  "Delete a memory document by its ID.",
  DeleteMemoryInput.shape,
  (input) => {
    const parsed = DeleteMemoryInput.safeParse(input);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const result = deleteMemory(db, parsed.data);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    return { content: [{ type: "text", text: `Deleted ${parsed.data.id}` }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log("info", "SIGTERM received, shutting down");
  db.close();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "thoth-mcp ready");

// ── Logging ───────────────────────────────────────────────────────────────────

function log(
  level: "info" | "warn" | "error",
  msg: string,
  ctx: Record<string, unknown> = {}
): void {
  process.stderr.write(
    JSON.stringify({ level, msg, ts: Date.now(), ...ctx }) + "\n"
  );
}
