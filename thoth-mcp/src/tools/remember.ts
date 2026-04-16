/**
 * store_memory tool — chunks, embeds, and BM25-indexes a document.
 */

import { z } from "zod";
import type Database from "better-sqlite3";
import { insertDocument } from "../memory/store.js";
import { indexDocument } from "../memory/bm25.js";
import { embed, updateEmbedding } from "../memory/vector.js";

export const StoreMemoryInput = z.object({
  content: z.string().min(1).describe("The text content to remember"),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Optional tags for categorisation"),
  source: z
    .string()
    .optional()
    .describe("Optional source identifier (file path, URL, etc.)"),
});

export type StoreMemoryInput = z.infer<typeof StoreMemoryInput>;

export interface StoreMemoryOutput {
  id: string;
  embedded: boolean;
  message: string;
}

export async function storeMemory(
  db: Database.Database,
  input: StoreMemoryInput,
  ollamaBaseUrl: string,
  embedModel: string
): Promise<{ ok: true; value: StoreMemoryOutput } | { ok: false; error: string }> {
  // Chunk large documents into ~512-token segments
  const chunks = chunkText(input.content, 512);

  const ids: string[] = [];
  let embeddedCount = 0;

  for (const chunk of chunks) {
    const doc = insertDocument(
      db,
      chunk,
      input.tags ?? [],
      input.source ?? null,
      null
    );

    indexDocument(db, doc.id, chunk);

    const embedResult = await embed(chunk, ollamaBaseUrl, embedModel);
    if (embedResult.ok) {
      updateEmbedding(db, doc.id, embedResult.value);
      embeddedCount++;
    } else {
      // Log but don't fail — BM25 still works without embeddings
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: "embedding failed",
          ts: Date.now(),
          docId: doc.id,
          error: embedResult.error,
        }) + "\n"
      );
    }

    ids.push(doc.id);
  }

  const embedded = embeddedCount === chunks.length;
  const message =
    chunks.length === 1
      ? `stored as ${ids[0]} (embedded: ${embedded})`
      : `stored ${chunks.length} chunks: ${ids.join(", ")} (embedded: ${embeddedCount}/${chunks.length})`;

  return {
    ok: true,
    value: { id: ids[0] as string, embedded, message },
  };
}

// ── Text chunking ─────────────────────────────────────────────────────────────

/**
 * Naive word-boundary chunker. Splits on paragraphs first, then words.
 * Targets `maxTokens` tokens (approx 4 chars/token).
 */
function chunkText(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text.slice(0, maxChars)];
}
