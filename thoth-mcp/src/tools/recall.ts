/**
 * search_memory, list_memories, delete_memory tool implementations.
 *
 * search_memory supports three modes:
 *   "hybrid"  — BM25 + vector RRF fusion (default); degrades to BM25-only if
 *               Ollama is unreachable, so it never hard-fails due to embedding
 *   "bm25"    — keyword-only
 *   "vector"  — semantic-only; returns an error if Ollama is unreachable
 *               (the caller explicitly asked for vector, so we surface the failure)
 */

import { z } from "zod";
import type Database from "better-sqlite3";
import { getDocument, listDocuments, deleteDocument } from "../memory/store.js";
import { bm25Search, removeIndex } from "../memory/bm25.js";
import { embed, vectorSearch, rrfFuse } from "../memory/vector.js";

// ── search_memory ─────────────────────────────────────────────────────────────

export const SearchMemoryInput = z.object({
  query: z.string().min(1).describe("Natural language or keyword search query"),
  mode: z
    .enum(["hybrid", "bm25", "vector"])
    .optional()
    .default("hybrid")
    .describe(
      "hybrid (default): BM25 + vector RRF, degrades to BM25 if Ollama is down; " +
        "bm25: keyword only; vector: semantic only (errors if Ollama unreachable)"
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(5)
    .describe("Maximum results to return (1–50, default 5)"),
});

export type SearchMemoryInput = z.infer<typeof SearchMemoryInput>;

export interface SearchResult {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  score: number;
}

export async function searchMemory(
  db: Database.Database,
  input: SearchMemoryInput,
  ollamaBaseUrl: string,
  embedModel: string
): Promise<{ ok: true; value: SearchResult[] } | { ok: false; error: string }> {
  const mode = input.mode ?? "hybrid";
  const limit = input.limit ?? 5;

  let rankedIds: { docId: string; score: number }[];

  if (mode === "bm25") {
    rankedIds = bm25Search(db, input.query, limit);

  } else if (mode === "vector") {
    const embedResult = await embed(input.query, ollamaBaseUrl, embedModel);
    if (!embedResult.ok) {
      return { ok: false, error: `Vector search failed: ${embedResult.error}` };
    }
    rankedIds = vectorSearch(db, embedResult.value, limit);

  } else {
    // hybrid — BM25 always runs; vector is best-effort
    const bm25Results = bm25Search(db, input.query, limit * 2);

    const embedResult = await embed(input.query, ollamaBaseUrl, embedModel);

    if (!embedResult.ok) {
      // Ollama down or timed out — degrade gracefully to BM25
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: "hybrid search: vector unavailable, using BM25 only",
          ts: Date.now(),
          error: embedResult.error,
        }) + "\n"
      );
      rankedIds = bm25Results.slice(0, limit);
    } else {
      const vectorResults = vectorSearch(db, embedResult.value, limit * 2);
      rankedIds = rrfFuse(bm25Results, vectorResults).slice(0, limit);
    }
  }

  const results: SearchResult[] = [];
  for (const { docId, score } of rankedIds) {
    const doc = getDocument(db, docId);
    if (doc) {
      results.push({ id: doc.id, content: doc.content, tags: doc.tags, source: doc.source, score });
    }
  }

  return { ok: true, value: results };
}

// ── list_memories ─────────────────────────────────────────────────────────────

export const ListMemoriesInput = z.object({
  tag: z.string().optional().describe("Filter by tag (optional)"),
});

export type ListMemoriesInput = z.infer<typeof ListMemoriesInput>;

export interface ListEntry {
  id: string;
  source: string | null;
  tags: string[];
  preview: string;
}

export function listMemories(
  db: Database.Database,
  input: ListMemoriesInput
): { ok: true; value: ListEntry[] } {
  const docs = listDocuments(db, input.tag);
  return {
    ok: true,
    value: docs.map((d) => ({
      id: d.id,
      source: d.source,
      tags: d.tags,
      preview: d.content.length > 120 ? d.content.slice(0, 120) + "…" : d.content,
    })),
  };
}

// ── delete_memory ─────────────────────────────────────────────────────────────

export const DeleteMemoryInput = z.object({
  id: z.string().uuid().describe("ID of the document to delete"),
});

export type DeleteMemoryInput = z.infer<typeof DeleteMemoryInput>;

export function deleteMemory(
  db: Database.Database,
  input: DeleteMemoryInput
): { ok: true; value: { deleted: true } } | { ok: false; error: string } {
  removeIndex(db, input.id); // remove BM25 terms first (FK cascade also handles it, but belt+suspenders)
  const deleted = deleteDocument(db, input.id);
  if (!deleted) {
    return { ok: false, error: `No document with id ${input.id}` };
  }
  return { ok: true, value: { deleted: true } };
}
