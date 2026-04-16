/**
 * Okapi BM25 retrieval over the document corpus.
 *
 * Indexing
 * --------
 * Raw term counts (integers) are stored in `bm25_terms.freq`.
 * The total token count for the document is written back to `documents.doc_len`
 * inside the same transaction so scoring never needs a separate docLen query.
 *
 * Scoring
 * -------
 * At query time a single JOIN per query term fetches (doc_id, freq, doc_len)
 * together — no N+1 per-document round-trips.
 *
 *   IDF  = log(1 + (N - df + 0.5) / (df + 0.5))
 *   TF'  = freq * (k1 + 1) / (freq + k1 * (1 - b + b * (docLen / avgDl)))
 *   score += IDF * TF'
 *
 * Parameters: k1 = 1.5, b = 0.75 (Robertson & Zaragoza defaults).
 */

import type Database from "better-sqlite3";
import { updateDocLen } from "./store.js";

const K1 = 1.5;
const B = 0.75;

export interface BM25Result {
  docId: string;
  score: number;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

/**
 * Index a document's content into `bm25_terms` and update `documents.doc_len`.
 * Must be called after `insertDocument`.
 */
export function indexDocument(
  db: Database.Database,
  docId: string,
  content: string
): void {
  const terms = tokenise(content);
  if (terms.length === 0) return;

  const counts = rawCounts(terms);
  const insert = db.prepare(
    "INSERT OR REPLACE INTO bm25_terms (doc_id, term, freq) VALUES (?, ?, ?)"
  );

  db.transaction(() => {
    for (const [term, freq] of Object.entries(counts)) {
      insert.run(docId, term, freq);
    }
    updateDocLen(db, docId, terms.length);
  })();
}

export function removeIndex(db: Database.Database, docId: string): void {
  db.prepare("DELETE FROM bm25_terms WHERE doc_id = ?").run(docId);
}

// ── Querying ──────────────────────────────────────────────────────────────────

export function bm25Search(
  db: Database.Database,
  query: string,
  limit = 10
): BM25Result[] {
  const queryTerms = [...new Set(tokenise(query))]; // dedup
  if (queryTerms.length === 0) return [];

  const { corpusSize, avgDl } = corpusStats(db);
  const scores = new Map<string, number>();

  // One JOIN query per unique query term — no N+1 per matching document
  const termStmt = db.prepare<[string], { doc_id: string; freq: number; doc_len: number }>(`
    SELECT bt.doc_id, bt.freq, d.doc_len
    FROM   bm25_terms bt
    JOIN   documents  d  ON bt.doc_id = d.id
    WHERE  bt.term = ?
  `);

  for (const term of queryTerms) {
    const rows = termStmt.all(term);
    if (rows.length === 0) continue;

    const df = rows.length;
    const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5));

    for (const { doc_id, freq, doc_len } of rows) {
      const dl = doc_len > 0 ? doc_len : 1;
      const tf =
        (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (dl / avgDl)));
      scores.set(doc_id, (scores.get(doc_id) ?? 0) + idf * tf);
    }
  }

  return Array.from(scores.entries())
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Tokenisation ──────────────────────────────────────────────────────────────

/**
 * Lowercase, strip non-word chars, split on whitespace, drop 1-char tokens.
 * Exported so tests and the chunker can reuse it.
 */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Raw (integer) term counts — NOT normalised. */
function rawCounts(terms: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of terms) {
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

function corpusStats(
  db: Database.Database
): { corpusSize: number; avgDl: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*)           AS n,
              COALESCE(AVG(doc_len), 1) AS avg_dl
       FROM   documents
       WHERE  doc_len > 0`
    )
    .get() as { n: number; avg_dl: number };

  return {
    corpusSize: row.n > 0 ? row.n : 1,
    avgDl: row.avg_dl > 0 ? row.avg_dl : 1,
  };
}
