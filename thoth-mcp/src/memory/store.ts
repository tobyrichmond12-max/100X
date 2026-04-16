/**
 * SQLite-backed document store.
 *
 * Schema:
 *   documents  — content, tags (JSON array), source, embedding BLOB, doc_len
 *   bm25_terms — raw per-term counts per document (doc_id, term, freq INTEGER)
 *
 * WAL mode + synchronous=NORMAL for crash safety on Jetson without tanking write perf.
 * doc_len stores the total token count for each document; BM25 reads it via a JOIN
 * so there are no separate per-doc queries at search time.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ── Public types ──────────────────────────────────────────────────────────────

export interface Document {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  createdAt: number;
  docLen: number; // total BM25 token count; 0 until indexDocument() is called
}

// Internal row shape returned by better-sqlite3
interface DocumentRow {
  id: string;
  content: string;
  tags: string; // JSON-serialised string[]
  source: string | null;
  created_at: number;
  doc_len: number;
  embedding: Buffer | null;
}

// ── DB setup ──────────────────────────────────────────────────────────────────

export function openStore(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id         TEXT    PRIMARY KEY,
      content    TEXT    NOT NULL,
      tags       TEXT    NOT NULL DEFAULT '[]',
      source     TEXT,
      created_at INTEGER NOT NULL,
      doc_len    INTEGER NOT NULL DEFAULT 0,
      embedding  BLOB
    );

    CREATE TABLE IF NOT EXISTS bm25_terms (
      doc_id TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      term   TEXT    NOT NULL,
      freq   INTEGER NOT NULL,
      PRIMARY KEY (doc_id, term)
    );

    CREATE INDEX IF NOT EXISTS idx_bm25_term ON bm25_terms(term);
  `);

  return db;
}

// ── Write operations ──────────────────────────────────────────────────────────

export function insertDocument(
  db: Database.Database,
  content: string,
  tags: string[],
  source: string | null
): Document {
  const id = randomUUID();
  const createdAt = Date.now();

  db.prepare(`
    INSERT INTO documents (id, content, tags, source, created_at, doc_len)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(id, content, JSON.stringify(tags), source, createdAt);

  return { id, content, tags, source, createdAt, docLen: 0 };
}

/**
 * Called by bm25.ts after indexing so document length is available for scoring.
 */
export function updateDocLen(
  db: Database.Database,
  id: string,
  docLen: number
): void {
  db.prepare("UPDATE documents SET doc_len = ? WHERE id = ?").run(docLen, id);
}

/**
 * Store a float32 embedding as a raw binary BLOB.
 * Uses byteOffset/byteLength so it is safe when the Float32Array is a view
 * into a larger (e.g. pooled) ArrayBuffer.
 */
export function updateEmbedding(
  db: Database.Database,
  id: string,
  embedding: Float32Array
): void {
  const buf = Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength
  );
  db.prepare("UPDATE documents SET embedding = ? WHERE id = ?").run(buf, id);
}

export function deleteDocument(db: Database.Database, id: string): boolean {
  return db.prepare("DELETE FROM documents WHERE id = ?").run(id).changes > 0;
}

// ── Read operations ───────────────────────────────────────────────────────────

export function getDocument(
  db: Database.Database,
  id: string
): Document | null {
  const row = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(id) as DocumentRow | undefined;
  return row ? rowToDoc(row) : null;
}

export function listDocuments(
  db: Database.Database,
  tag?: string
): Document[] {
  const rows: DocumentRow[] = tag
    ? (db
        .prepare(
          "SELECT * FROM documents WHERE tags LIKE ? ORDER BY created_at DESC"
        )
        .all(`%"${tag}"%`) as DocumentRow[])
    : (db
        .prepare("SELECT * FROM documents ORDER BY created_at DESC")
        .all() as DocumentRow[]);

  return rows.map(rowToDoc);
}

/**
 * Read all embeddings in one pass for brute-force vector search.
 * Returns an iterator of (id, Float32Array) pairs.
 */
export function* iterEmbeddings(
  db: Database.Database
): Generator<{ id: string; vec: Float32Array }> {
  const rows = db
    .prepare("SELECT id, embedding FROM documents WHERE embedding IS NOT NULL")
    .all() as { id: string; embedding: Buffer }[];

  for (const { id, embedding } of rows) {
    yield { id, vec: bufToFloat32(embedding) };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a better-sqlite3 Buffer BLOB to a Float32Array.
 * Must account for byteOffset: Node.js Buffers can be views into a pooled
 * ArrayBuffer where byteOffset != 0.
 */
export function bufToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

function rowToDoc(row: DocumentRow): Document {
  return {
    id: row.id,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    source: row.source,
    createdAt: row.created_at,
    docLen: row.doc_len,
  };
}
