import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openStore, insertDocument } from "./store.js";
import { indexDocument, removeIndex, bm25Search, tokenise } from "./bm25.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  // :memory: gives an isolated DB per test with no disk I/O
  return openStore(":memory:");
}

function addDoc(db: Database.Database, content: string): string {
  const doc = insertDocument(db, content, [], null);
  indexDocument(db, doc.id, content);
  return doc.id;
}

// ── tokenise ──────────────────────────────────────────────────────────────────

describe("tokenise", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokenise("Hello, World!")).toEqual(["hello", "world"]);
  });

  it("drops single-character tokens", () => {
    expect(tokenise("a b cc dd")).toEqual(["cc", "dd"]);
  });

  it("handles multiple whitespace and empty string", () => {
    expect(tokenise("  ")).toEqual([]);
    expect(tokenise("")).toEqual([]);
  });

  it("preserves repeated tokens (needed for raw count accuracy)", () => {
    const tokens = tokenise("the cat sat on the mat the");
    expect(tokens.filter((t) => t === "the")).toHaveLength(3);
  });
});

// ── indexDocument / bm25Search ────────────────────────────────────────────────

describe("bm25Search", () => {
  it("returns empty array for empty corpus", () => {
    const db = freshDb();
    expect(bm25Search(db, "anything")).toEqual([]);
  });

  it("returns empty array for query with no tokenisable terms", () => {
    const db = freshDb();
    addDoc(db, "some content here");
    expect(bm25Search(db, "!")).toEqual([]);
  });

  it("finds the one matching document", () => {
    const db = freshDb();
    const id = addDoc(db, "the quick brown fox jumps over the lazy dog");
    const results = bm25Search(db, "fox");
    expect(results).toHaveLength(1);
    expect(results[0]?.docId).toBe(id);
  });

  it("ranks exact-match document above partial-match", () => {
    const db = freshDb();
    // Short doc with one hit on 'typescript'
    const idExact = addDoc(db, "typescript is a typed superset of javascript");
    // Long filler doc that also mentions typescript once among many other words
    addDoc(
      db,
      "javascript python ruby typescript java go rust swift kotlin scala " +
        "haskell elixir erlang clojure lisp scheme prolog fortran cobol"
    );

    const results = bm25Search(db, "typescript");
    expect(results[0]?.docId).toBe(idExact);
  });

  it("accumulates scores across multiple query terms", () => {
    const db = freshDb();
    const idBoth = addDoc(db, "rust ownership borrowing lifetimes");
    const idOne = addDoc(db, "rust is fast");

    const results = bm25Search(db, "rust ownership");
    // doc with both terms must outrank the one with only 'rust'
    expect(results[0]?.docId).toBe(idBoth);
  });

  it("deduplicates query terms so repeated terms don't double-score", () => {
    const db = freshDb();
    const id = addDoc(db, "apple apple apple");
    const resultsOnce = bm25Search(db, "apple");
    const resultsTwice = bm25Search(db, "apple apple");
    // Scores should be identical because we deduplicate query terms
    expect(resultsTwice[0]?.score).toBeCloseTo(resultsOnce[0]?.score ?? 0, 5);
    expect(results).toBeDefined();
    void id;
  });

  it("respects the limit parameter", () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) addDoc(db, `document about widgets number ${i}`);
    expect(bm25Search(db, "document", 3)).toHaveLength(3);
  });

  it("a term that appears in all docs gets lower IDF than a rare term", () => {
    const db = freshDb();
    // 'common' appears in all 5 docs; 'rare' only in doc[0]
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(addDoc(db, i === 0 ? "common rare word" : "common filler word"));
    }

    const byRare = bm25Search(db, "rare", 1);
    const byCommon = bm25Search(db, "common", 5);

    // The rare-term score for the one matching doc should be higher than
    // the common-term score for any single doc (IDF is much larger)
    expect(byRare[0]?.score ?? 0).toBeGreaterThan(byCommon[0]?.score ?? 0);
  });
});

// ── removeIndex ───────────────────────────────────────────────────────────────

describe("removeIndex", () => {
  it("makes the document unsearchable after removal", () => {
    const db = freshDb();
    const id = addDoc(db, "unique canary phrase xyzzy");
    expect(bm25Search(db, "xyzzy")).toHaveLength(1);
    removeIndex(db, id);
    expect(bm25Search(db, "xyzzy")).toHaveLength(0);
  });
});

// ── doc_len written correctly ─────────────────────────────────────────────────

describe("doc_len", () => {
  it("is stored as the number of tokens in the document", () => {
    const db = freshDb();
    const content = "one two three four five"; // 5 tokens
    const doc = insertDocument(db, content, [], null);
    indexDocument(db, doc.id, content);

    const row = db
      .prepare("SELECT doc_len FROM documents WHERE id = ?")
      .get(doc.id) as { doc_len: number };

    expect(row.doc_len).toBe(5);
  });

  it("affects length normalisation: short doc beats long doc for same tf", () => {
    const db = freshDb();
    // Both mention 'needle' once, but short doc has far fewer total tokens
    const shortId = addDoc(db, "needle point");
    const longId = addDoc(
      db,
      "needle " + Array(50).fill("filler").join(" ")
    );

    const results = bm25Search(db, "needle");
    const shortScore = results.find((r) => r.docId === shortId)?.score ?? 0;
    const longScore = results.find((r) => r.docId === longId)?.score ?? 0;

    // BM25 length normalisation should penalise the long doc
    expect(shortScore).toBeGreaterThan(longScore);
  });
});
