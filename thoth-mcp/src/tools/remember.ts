/**
 * store_memory tool implementation.
 *
 * Large documents are split into ~512-token chunks so each chunk fits
 * comfortably in the embedding model's context window.  Every chunk is:
 *   1. Inserted into the documents table
 *   2. BM25-indexed (raw term counts + doc_len updated)
 *   3. Embedded via Ollama (best-effort — BM25 still works if Ollama is down)
 */

import { z } from "zod";
import type Database from "better-sqlite3";
import { insertDocument, updateEmbedding } from "../memory/store.js";
import { indexDocument } from "../memory/bm25.js";
import { embed } from "../memory/vector.js";

// ── Schema ────────────────────────────────────────────────────────────────────

export const StoreMemoryInput = z.object({
  content: z.string().min(1).describe("The text content to store"),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Optional tags for later filtering (e.g. ['project:foo', 'lang:ts'])"),
  source: z
    .string()
    .optional()
    .describe("Optional provenance label: file path, URL, etc."),
});

export type StoreMemoryInput = z.infer<typeof StoreMemoryInput>;

export interface StoreMemoryOutput {
  ids: string[];
  chunks: number;
  embeddedChunks: number;
  message: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

export async function storeMemory(
  db: Database.Database,
  input: StoreMemoryInput,
  ollamaBaseUrl: string,
  embedModel: string
): Promise<{ ok: true; value: StoreMemoryOutput } | { ok: false; error: string }> {
  const chunks = chunkText(input.content);
  const tags = input.tags ?? [];
  const source = input.source ?? null;

  const ids: string[] = [];
  let embeddedChunks = 0;

  for (const chunk of chunks) {
    // 1. Persist content
    const doc = insertDocument(db, chunk, tags, source);

    // 2. BM25 index (also writes doc_len)
    indexDocument(db, doc.id, chunk);

    // 3. Embed — failures are non-fatal; BM25 still retrieves the chunk
    const embedResult = await embed(chunk, ollamaBaseUrl, embedModel);
    if (embedResult.ok) {
      updateEmbedding(db, doc.id, embedResult.value);
      embeddedChunks++;
    } else {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: "embedding failed for chunk",
          ts: Date.now(),
          docId: doc.id,
          error: embedResult.error,
        }) + "\n"
      );
    }

    ids.push(doc.id);
  }

  const message =
    chunks.length === 1
      ? `stored ${ids[0]} (embedded: ${embeddedChunks === 1})`
      : `stored ${chunks.length} chunks [${ids.join(", ")}] (embedded: ${embeddedChunks}/${chunks.length})`;

  return {
    ok: true,
    value: { ids, chunks: chunks.length, embeddedChunks, message },
  };
}

// ── Text chunking ─────────────────────────────────────────────────────────────

const MAX_TOKENS = 512;
const CHARS_PER_TOKEN = 4; // rough approximation
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

/**
 * Split text into chunks of up to MAX_CHARS characters.
 *
 * Strategy (greedy, paragraph-aware):
 *   1. Split on blank lines (paragraph boundaries)
 *   2. Accumulate paragraphs until the chunk would exceed MAX_CHARS
 *   3. If a single paragraph exceeds MAX_CHARS, split it at sentence boundaries,
 *      then at word boundaries as a last resort
 */
function chunkText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;

    if (candidate.length <= MAX_CHARS) {
      current = candidate;
      continue;
    }

    // Flush what we have so far
    if (current) {
      chunks.push(current);
      current = "";
    }

    // The paragraph itself may be too long — split it further
    if (para.length <= MAX_CHARS) {
      current = para;
    } else {
      // Split on sentence boundaries first
      const sentences = para.match(/[^.!?]+[.!?]+\s*/g) ?? [para];
      for (const sentence of sentences) {
        const next = current ? current + sentence : sentence;
        if (next.length <= MAX_CHARS) {
          current = next;
        } else {
          if (current) chunks.push(current);
          // Hard-split at MAX_CHARS on a word boundary
          current = splitAtWordBoundary(sentence, chunks);
        }
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text.slice(0, MAX_CHARS)];
}

/** Splits `text` at word boundaries ≤ MAX_CHARS, pushing all-but-last to chunks. */
function splitAtWordBoundary(text: string, chunks: string[]): string {
  let remaining = text;
  while (remaining.length > MAX_CHARS) {
    const slice = remaining.slice(0, MAX_CHARS);
    const lastSpace = slice.lastIndexOf(" ");
    const boundary = lastSpace > 0 ? lastSpace : MAX_CHARS;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trimStart();
  }
  return remaining;
}
