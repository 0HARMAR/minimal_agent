/**
 * BM25 indexer for code chunks.
 *
 * Implements the Okapi BM25 ranking function on in-memory inverted index.
 * Uses code-aware tokenization: splits on whitespace and special chars,
 * preserves camelCase parts, lowercases everything.
 */

import type { CodeChunk } from "./types.js";

// ── Code-aware tokenizer ──────────────────────────────────────────────────

/**
 * Tokenize source code text for BM25.
 *
 * Strategy:
 * 1. Split on non-alphanumeric characters
 * 2. Split camelCase and PascalCase into parts (e.g. "getUser" → "get", "user")
 * 3. Lowercase everything
 * 4. Filter out single-char tokens and pure number tokens
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // Split on non-alphanumeric chars, keeping alphanumeric sequences
  const parts = text.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  for (const part of parts) {
    if (part.length <= 1) continue;
    if (/^\d+$/.test(part)) continue; // pure numbers

    // Split camelCase / PascalCase / SCREAMING_SNAKE
    // e.g. "getUser" → ["get", "user"]
    // e.g. "onPlanGenerated" → ["on", "plan", "generated"]
    // e.g. "MAX_ITERATIONS" → ["max", "iterations"]
    const subParts = part
      .replace(/([a-z])([A-Z])/g, "$1 $2")      // camelCase boundary
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")  // consecutive caps before lowercase
      .split(/[_\-./]+/)                          // snake/kebab/dot
      .flatMap((s) => s.split(/\s+/))
      .map((s) => s.toLowerCase())
      .filter((s) => s.length > 1);

    tokens.push(...subParts);
  }

  return tokens;
}

// ── BM25 Index ────────────────────────────────────────────────────────────

export interface BM25Doc {
  id: string;
  tokens: string[];
  length: number;
}

export interface BM25Result {
  chunk: CodeChunk;
  score: number;
}

/**
 * Pure Okapi BM25 implementation with configurable k1 and b parameters.
 *
 * Default values (k1=1.5, b=0.75) are the standard tuned parameters.
 */
export class BM25Index {
  // Inverted index: term → Map<docId, termFrequency>
  private index = new Map<string, Map<string, number>>();

  // Per-document token counts
  private docLengths = new Map<string, number>();

  // Document metadata (id → chunk)
  private docs = new Map<string, CodeChunk>();

  // Cached corpus-level stats
  private totalDocs = 0;
  private avgDocLength = 0;
  private dirty = false;

  /** BM25 k1 parameter — controls term frequency saturation. Default 1.5 */
  k1 = 1.5;

  /** BM25 b parameter — controls length normalization. Default 0.75 */
  b = 0.75;

  // ── Build / update ──────────────────────────────────────────────────

  /** Add all chunks in one go (replaces any existing index). */
  build(chunks: CodeChunk[]): void {
    this.index.clear();
    this.docLengths.clear();
    this.docs.clear();
    this.totalDocs = 0;
    this.avgDocLength = 0;

    for (const chunk of chunks) {
      this.addDoc(chunk);
    }
    this.refreshStats();
    this.dirty = false;
  }

  /** Add or update a single chunk. */
  add(chunk: CodeChunk): void {
    this.remove(chunk.id);
    this.addDoc(chunk);
    this.dirty = true;
  }

  /** Remove a chunk by its id. */
  remove(id: string): void {
    const oldLen = this.docLengths.get(id);
    if (oldLen === undefined) return;

    // Remove from inverted index
    for (const [, docMap] of this.index) {
      docMap.delete(id);
    }
    this.docLengths.delete(id);
    this.docs.delete(id);
    this.totalDocs = this.docs.size;
    this.dirty = true;
  }

  /** Remove all chunks from a given file. */
  removeFile(filePath: string): void {
    for (const [id, chunk] of this.docs) {
      if (chunk.filePath === filePath) this.remove(id);
    }
  }

  /** Clear the entire index. */
  clear(): void {
    this.index.clear();
    this.docLengths.clear();
    this.docs.clear();
    this.totalDocs = 0;
    this.avgDocLength = 0;
    this.dirty = false;
  }

  // ── Search ──────────────────────────────────────────────────────────

  /**
   * Search the BM25 index and return results sorted by score descending.
   *
   * @param query Raw query string (tokenized internally)
   * @param maxResults Max results to return (default 20)
   */
  search(query: string, maxResults = 20): BM25Result[] {
    if (this.totalDocs === 0) return [];

    // Ensure stats are up to date
    if (this.dirty) this.refreshStats();

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Collect unique query tokens (with frequency for multi-occurrence scoring)
    const qTermFreq = new Map<string, number>();
    for (const t of queryTokens) {
      qTermFreq.set(t, (qTermFreq.get(t) ?? 0) + 1);
    }

    // Accumulate BM25 scores per document
    const scores = new Map<string, number>();

    for (const [term, qFreq] of qTermFreq) {
      const postings = this.index.get(term);
      if (!postings) continue; // term not in corpus

      const df = postings.size;          // document frequency
      const idf = Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5));

      for (const [docId, tf] of postings) {
        const docLen = this.docLengths.get(docId)!;
        const num = tf * (this.k1 + 1);
        const denom = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength));
        const score = idf * (num / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }

    // Sort by score descending
    const sorted = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults);

    return sorted.map(([id, score]) => ({
      chunk: this.docs.get(id)!,
      score,
    }));
  }

  // ── Private ─────────────────────────────────────────────────────────

  private addDoc(chunk: CodeChunk): void {
    const tokens = tokenize(chunk.content);
    const docId = chunk.id;

    this.docs.set(docId, chunk);
    this.docLengths.set(docId, tokens.length);

    // Build per-term frequencies
    const termFreq = new Map<string, number>();
    for (const t of tokens) {
      termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    }

    // Add to inverted index
    for (const [term, freq] of termFreq) {
      let postings = this.index.get(term);
      if (!postings) {
        postings = new Map();
        this.index.set(term, postings);
      }
      postings.set(docId, freq);
    }

    this.totalDocs = this.docs.size;
  }

  private refreshStats(): void {
    this.totalDocs = this.docs.size;
    if (this.totalDocs === 0) {
      this.avgDocLength = 0;
      return;
    }
    let totalLen = 0;
    for (const len of this.docLengths.values()) {
      totalLen += len;
    }
    this.avgDocLength = totalLen / this.totalDocs;
    this.dirty = false;
  }

  /** Return index stats for debugging. */
  stats(): { totalDocs: number; avgDocLength: number; vocabSize: number } {
    if (this.dirty) this.refreshStats();
    return {
      totalDocs: this.totalDocs,
      avgDocLength: Math.round(this.avgDocLength * 100) / 100,
      vocabSize: this.index.size,
    };
  }
}
