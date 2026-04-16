/**
 * Embedding generation (via Ollama) and cosine similarity search.
 * Embeddings are float32, stored as raw binary blobs in SQLite.
 * No external vector DB — cosine similarity computed in JS over fetched rows.
 */

import type Database from "better-sqlite3";

export interface VectorResult {
  docId: string;
  score: number; // cosine similarity [0, 1]
}

// ── Embedding generation ──────────────────────────────────────────────────────

export async function embed(
  text: string,
  ollamaBaseUrl: string,
  model: string
): Promise<{ ok: true; value: Float32Array } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${ollamaBaseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
  } catch (err) {
    return { ok: false, error: `Ollama fetch failed: ${String(err)}` };
  }

  if (!res.ok) {
    return { ok: false, error: `Ollama HTTP ${res.status}: ${await res.text()}` };
  }

  const json = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(json.embedding)) {
    return { ok: false, error: "Ollama response missing embedding field" };
  }

  return { ok: true, value: new Float32Array(json.embedding) };
}

// ── Vector search ─────────────────────────────────────────────────────────────

/**
 * Brute-force cosine similarity over all documents that have embeddings.
 * Acceptable for corpus sizes up to ~50k docs on Jetson; revisit with HNSW if needed.
 */
export function vectorSearch(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit = 10
): VectorResult[] {
  const rows = db
    .prepare("SELECT id, embedding FROM documents WHERE embedding IS NOT NULL")
    .all() as { id: string; embedding: Buffer }[];

  const results: VectorResult[] = rows.map(({ id, embedding }) => {
    const vec = new Float32Array(embedding.buffer);
    return { docId: id, score: cosineSimilarity(queryEmbedding, vec) };
  });

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Math ──────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

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

/** Reciprocal rank fusion of BM25 + vector result sets. k=60 is standard. */
export function rrfFuse(
  bm25Results: { docId: string; score: number }[],
  vectorResults: VectorResult[],
  k = 60
): { docId: string; score: number }[] {
  const scores = new Map<string, number>();

  const addRank = (list: { docId: string }[]) => {
    list.forEach(({ docId }, rank) => {
      scores.set(docId, (scores.get(docId) ?? 0) + 1 / (k + rank + 1));
    });
  };

  addRank(bm25Results);
  addRank(vectorResults);

  return Array.from(scores.entries())
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score);
}
