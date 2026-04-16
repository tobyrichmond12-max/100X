/**
 * search_memory tool — hybrid BM25 + vector retrieval with RRF fusion.
 * list_memories and delete_memory are also implemented here.
 */

import { z } from "zod";
import type Database from "better-sqlite3";
import { getDocument, listDocuments, deleteDocument } from "../memory/store.js";
import { bm25Search } from "../memory/bm25.js";
import { embed, vectorSearch, rrfFuse } from "../memory/vector.js";
import { removeIndex } from "../memory/bm25.js";

// ── search_memory ─────────────────────────────────────────────────────────────

export const SearchMemoryInput = z.object({
  query: z.string().min(1).describe("Search query"),
  mode: z
    .enum(["hybrid", "bm25", "vector"])
    .optional()
    .default("hybrid")
    .describe("Retrieval mode: hybrid (default), bm25-only, or vector-only"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(5)
    .describe("Maximum number of results to return"),
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
      return { ok: false, error: `Embedding failed: ${embedResult.error}` };
    }
    rankedIds = vectorSearch(db, embedResult.value, limit);
  } else {
    // hybrid: fuse BM25 + vector via RRF
    const bm25Results = bm25Search(db, input.query, limit * 2);

    const embedResult = await embed(input.query, ollamaBaseUrl, embedModel);
    const vectorResults = embedResult.ok
      ? vectorSearch(db, embedResult.value, limit * 2)
      : [];

    if (!embedResult.ok) {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: "vector search unavailable, falling back to BM25",
          ts: Date.now(),
          error: embedResult.error,
        }) + "\n"
      );
    }

    rankedIds = rrfFuse(bm25Results, vectorResults).slice(0, limit);
  }

  const results: SearchResult[] = [];
  for (const { docId, score } of rankedIds) {
    const doc = getDocument(db, docId);
    if (doc) {
      results.push({ ...doc, score });
    }
  }

  return { ok: true, value: results };
}

// ── list_memories ─────────────────────────────────────────────────────────────

export const ListMemoriesInput = z.object({
  tag: z.string().optional().describe("Filter by tag (optional)"),
});

export type ListMemoriesInput = z.infer<typeof ListMemoriesInput>;

export function listMemories(
  db: Database.Database,
  input: ListMemoriesInput
): { ok: true; value: { id: string; source: string | null; tags: string[]; preview: string }[] } {
  const docs = listDocuments(db, input.tag);
  return {
    ok: true,
    value: docs.map((d) => ({
      id: d.id,
      source: d.source,
      tags: d.tags,
      preview: d.content.slice(0, 120) + (d.content.length > 120 ? "…" : ""),
    })),
  };
}

// ── delete_memory ─────────────────────────────────────────────────────────────

export const DeleteMemoryInput = z.object({
  id: z.string().uuid().describe("Document ID to delete"),
});

export type DeleteMemoryInput = z.infer<typeof DeleteMemoryInput>;

export function deleteMemory(
  db: Database.Database,
  input: DeleteMemoryInput
): { ok: true; value: { deleted: boolean } } | { ok: false; error: string } {
  removeIndex(db, input.id);
  const deleted = deleteDocument(db, input.id);
  if (!deleted) {
    return { ok: false, error: `No document found with id ${input.id}` };
  }
  return { ok: true, value: { deleted: true } };
}
