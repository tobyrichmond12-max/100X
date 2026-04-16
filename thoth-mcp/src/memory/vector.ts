/**
 * Embedding generation (via Ollama) and cosine similarity search.
 *
 * Embeddings
 * ----------
 * Calls Ollama's POST /api/embed endpoint (introduced in Ollama 0.1.26;
 * the older /api/embeddings endpoint returns 404 on current builds).
 * Request:  { model, input: text }
 * Response: { embeddings: [[...float64...]] }  — take embeddings[0].
 * Returns float32 values; stored as raw binary BLOBs in SQLite via store.ts.
 *
 * Vector search
 * -------------
 * Brute-force cosine similarity over all embedded documents.  O(n) in corpus
 * size; acceptable up to ~50 k docs on the Jetson 8 GB.  Switch to an HNSW
 * index (hnswlib-node) if recall latency becomes a problem beyond that.
 *
 * Hybrid search
 * -------------
 * rrfFuse() merges a BM25 ranked list with a vector ranked list using
 * Reciprocal Rank Fusion (k = 60).  Each list contributes 1/(k + rank + 1).
 */

import type Database from "better-sqlite3";
import { iterEmbeddings } from "./store.js";

const EMBED_TIMEOUT_MS = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VectorResult {
  docId: string;
  score: number; // cosine similarity in [-1, 1]; nomic-embed-text produces [0, 1]
}

// ── Embedding via Ollama ──────────────────────────────────────────────────────

export async function embed(
  text: string,
  ollamaBaseUrl: string,
  model: string
): Promise<{ ok: true; value: Float32Array } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${ollamaBaseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? `Ollama timed out after ${EMBED_TIMEOUT_MS}ms`
        : `Ollama unreachable: ${String(err)}`;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Ollama HTTP ${res.status}: ${body}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Ollama returned non-JSON response" };
  }

  // /api/embed returns { embeddings: [[...], ...] } — one inner array per input.
  // We always send a single string so we expect exactly one inner array.
  const obj = json as Record<string, unknown>;
  if (
    typeof obj !== "object" ||
    obj === null ||
    !Array.isArray(obj["embeddings"]) ||
    !Array.isArray((obj["embeddings"] as unknown[])[0])
  ) {
    return { ok: false, error: "Ollama response missing 'embeddings[0]' array" };
  }

  const raw = (obj["embeddings"] as unknown[][])[0] as unknown[];
  if (raw.some((v) => typeof v !== "number")) {
    return { ok: false, error: "Ollama embedding contains non-numeric values" };
  }

  return { ok: true, value: new Float32Array(raw as number[]) };
}

// ── Vector search ─────────────────────────────────────────────────────────────

/**
 * Fetch all stored embeddings and return the top-k by cosine similarity.
 * iterEmbeddings() handles the Buffer → Float32Array conversion with correct
 * byteOffset so pooled Node.js Buffers are handled safely.
 */
export function vectorSearch(
  db: Database.Database,
  queryVec: Float32Array,
  limit = 10
): VectorResult[] {
  const results: VectorResult[] = [];

  for (const { id, vec } of iterEmbeddings(db)) {
    const score = cosineSimilarity(queryVec, vec);
    results.push({ docId: id, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Math ──────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Reciprocal Rank Fusion of two ranked lists.
 *
 *   score(d) = Σ  1 / (k + rank(d, list) + 1)
 *
 * k = 60 suppresses the outsized influence of top-1 results (standard value).
 * Documents appearing in both lists get contributions from each.
 */
export function rrfFuse(
  bm25Results: { docId: string; score: number }[],
  vectorResults: VectorResult[],
  k = 60
): { docId: string; score: number }[] {
  const fused = new Map<string, number>();

  const addList = (list: { docId: string }[]) => {
    for (let rank = 0; rank < list.length; rank++) {
      const { docId } = list[rank] as { docId: string };
      fused.set(docId, (fused.get(docId) ?? 0) + 1 / (k + rank + 1));
    }
  };

  addList(bm25Results);
  addList(vectorResults);

  return Array.from(fused.entries())
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score);
}
