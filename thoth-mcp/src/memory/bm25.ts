/**
 * BM25 (Okapi BM25) retrieval over the document corpus.
 *
 * Term frequencies are pre-indexed into the `bm25_terms` table.
 * At query time we compute BM25 scores in JS against the stored TF rows.
 *
 * Parameters: k1=1.5, b=0.75 (standard defaults).
 */

import type Database from "better-sqlite3";

const K1 = 1.5;
const B = 0.75;

export interface BM25Result {
  docId: string;
  score: number;
}

// ── Indexing ─────────────────────────────────────────────────────────────────

export function indexDocument(
  db: Database.Database,
  docId: string,
  content: string
): void {
  const terms = tokenise(content);
  const tf = termFrequencies(terms);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO bm25_terms (doc_id, term, freq) VALUES (?, ?, ?)"
  );

  const insertMany = db.transaction((entries: [string, number][]) => {
    for (const [term, freq] of entries) {
      insert.run(docId, term, freq);
    }
  });

  insertMany(Object.entries(tf));
}

export function removeIndex(db: Database.Database, docId: string): void {
  db.prepare("DELETE FROM bm25_terms WHERE doc_id = ?").run(docId);
}

// ── Query ─────────────────────────────────────────────────────────────────────

export function bm25Search(
  db: Database.Database,
  query: string,
  limit = 10
): BM25Result[] {
  const queryTerms = tokenise(query);
  if (queryTerms.length === 0) return [];

  const { avgDl, corpusSize } = corpusStats(db);

  const scores = new Map<string, number>();

  for (const term of queryTerms) {
    const rows = db
      .prepare(
        "SELECT doc_id, freq FROM bm25_terms WHERE term = ?"
      )
      .all(term) as { doc_id: string; freq: number }[];

    if (rows.length === 0) continue;

    const df = rows.length;
    const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5));

    for (const { doc_id, freq } of rows) {
      const docLen = docLength(db, doc_id);
      const tf = freq * (K1 + 1) / (freq + K1 * (1 - B + B * (docLen / avgDl)));
      const contribution = idf * tf;
      scores.set(doc_id, (scores.get(doc_id) ?? 0) + contribution);
    }
  }

  return Array.from(scores.entries())
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function termFrequencies(terms: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of terms) {
    tf[t] = (tf[t] ?? 0) + 1;
  }
  // Normalise by doc length
  const len = terms.length || 1;
  for (const t of Object.keys(tf)) {
    tf[t] = (tf[t] as number) / len;
  }
  return tf;
}

function docLength(db: Database.Database, docId: string): number {
  const row = db
    .prepare("SELECT SUM(freq) AS total FROM bm25_terms WHERE doc_id = ?")
    .get(docId) as { total: number | null };
  return row.total ?? 1;
}

function corpusStats(
  db: Database.Database
): { avgDl: number; corpusSize: number } {
  const countRow = db
    .prepare("SELECT COUNT(DISTINCT doc_id) AS n FROM bm25_terms")
    .get() as { n: number };
  const corpusSize = countRow.n || 1;

  const avgRow = db
    .prepare(
      "SELECT AVG(s) AS avg_dl FROM (SELECT SUM(freq) AS s FROM bm25_terms GROUP BY doc_id)"
    )
    .get() as { avg_dl: number | null };
  const avgDl = avgRow.avg_dl ?? 1;

  return { avgDl, corpusSize };
}
