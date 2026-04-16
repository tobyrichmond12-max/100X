/**
 * SQLite-backed document store.
 * Holds raw content, BM25 term frequencies, and float32 embedding blobs.
 * WAL mode is enabled for crash safety on the Jetson.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Document {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  createdAt: number;
}

export interface DocumentRow {
  id: string;
  content: string;
  tags: string; // JSON array
  source: string | null;
  created_at: number;
  embedding: Buffer | null;
}

export function openStore(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      tags       TEXT NOT NULL DEFAULT '[]',
      source     TEXT,
      created_at INTEGER NOT NULL,
      embedding  BLOB
    );

    CREATE TABLE IF NOT EXISTS bm25_terms (
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      term   TEXT NOT NULL,
      freq   REAL NOT NULL,
      PRIMARY KEY (doc_id, term)
    );

    CREATE INDEX IF NOT EXISTS bm25_terms_term ON bm25_terms(term);
  `);

  return db;
}

export function insertDocument(
  db: Database.Database,
  content: string,
  tags: string[],
  source: string | null,
  embedding: Float32Array | null
): Document {
  const id = randomUUID();
  const createdAt = Date.now();

  const stmt = db.prepare(`
    INSERT INTO documents (id, content, tags, source, created_at, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    content,
    JSON.stringify(tags),
    source,
    createdAt,
    embedding ? Buffer.from(embedding.buffer) : null
  );

  return { id, content, tags, source, createdAt };
}

export function getDocument(
  db: Database.Database,
  id: string
): Document | null {
  const row = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(id) as DocumentRow | undefined;

  if (!row) return null;
  return rowToDoc(row);
}

export function deleteDocument(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  return result.changes > 0;
}

export function listDocuments(
  db: Database.Database,
  tag?: string
): Document[] {
  let rows: DocumentRow[];
  if (tag) {
    // Tags stored as JSON array; use LIKE for simple membership check
    rows = db
      .prepare(
        "SELECT * FROM documents WHERE tags LIKE ? ORDER BY created_at DESC"
      )
      .all(`%"${tag}"%`) as DocumentRow[];
  } else {
    rows = db
      .prepare("SELECT * FROM documents ORDER BY created_at DESC")
      .all() as DocumentRow[];
  }
  return rows.map(rowToDoc);
}

export function getEmbedding(
  db: Database.Database,
  id: string
): Float32Array | null {
  const row = db
    .prepare("SELECT embedding FROM documents WHERE id = ?")
    .get(id) as Pick<DocumentRow, "embedding"> | undefined;

  if (!row?.embedding) return null;
  return new Float32Array(row.embedding.buffer);
}

export function updateEmbedding(
  db: Database.Database,
  id: string,
  embedding: Float32Array
): void {
  db.prepare("UPDATE documents SET embedding = ? WHERE id = ?").run(
    Buffer.from(embedding.buffer),
    id
  );
}

function rowToDoc(row: DocumentRow): Document {
  return {
    id: row.id,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    source: row.source,
    createdAt: row.created_at,
  };
}
