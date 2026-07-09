/**
 * Hybrid search — combines dense vector (embedding) and sparse (BM25) retrieval
 * with configurable alpha weighting.
 *
 * Usage:
 *   const hybrid = new HybridSearch(embedder, bm25Index);
 *   await hybrid.indexChunks(chunks);          // embed + index all chunks
 *   const results = await hybrid.search("find user by email");
 */

import type { CodeChunk } from "./types.js";
import { Embedder, type EmbeddingResult } from "./embedder.js";
import { BM25Index } from "./bm25.js";

export interface HybridResult {
  chunk: CodeChunk;
  score: number;        // combined score (0-1 range, higher = better)
  denseScore: number;
  sparseScore: number;
}

export interface HybridSearchOpts {
  /** Weight for dense (embedding) score in [0,1]. Default 0.5.
   *  sparse weight = 1 - alpha. */
  alpha?: number;
  /** Max results to return from each retriever before fusion. Default 30. */
  candidateK?: number;
  /** Final result count after fusion. Default 10. */
  topK?: number;
}

/**
 * Hybrid search using Reciprocal Rank Fusion (RRF) to combine
 * dense (embedding) and sparse (BM25) result rankings.
 *
 * RRF score = Σ (1 / (rank + k)) for each source, where k=60 (standard).
 * This produces a stable combined ranking without needing score normalization.
 */
export class HybridSearch {
  private embedder: Embedder;
  private bm25: BM25Index;

  /** Cached embedding vectors per chunk id */
  private vectors = new Map<string, number[]>();

  private alpha: number;
  private candidateK: number;
  private topK: number;

  constructor(
    embedder: Embedder,
    bm25: BM25Index,
    opts: HybridSearchOpts = {},
  ) {
    this.embedder = embedder;
    this.bm25 = bm25;
    this.alpha = opts.alpha ?? 0.5;
    this.candidateK = opts.candidateK ?? 30;
    this.topK = opts.topK ?? 10;
  }

  // ── Indexing ────────────────────────────────────────────────────────

  /**
   * Index a batch of chunks: embed them via Ollama, add to BM25,
   * and cache the vectors.
   */
  async indexChunks(chunks: CodeChunk[]): Promise<void> {
    // BM25 index
    this.bm25.build(chunks);

    // Embed
    const results = await this.embedder.embedBatch(chunks);
    for (const r of results) {
      this.vectors.set(r.chunk.id, r.vector);
    }
    console.log(
      `HybridSearch: indexed ${chunks.length} chunks, ` +
      `${results.length} embedded successfully`,
    );
  }

  /**
   * Add a single chunk. Returns true if embedding succeeded.
   */
  async addChunk(chunk: CodeChunk): Promise<boolean> {
    this.bm25.add(chunk);
    const vec = await this.embedder.embed(chunk.content);
    if (vec) {
      this.vectors.set(chunk.id, vec);
      return true;
    }
    return false;
  }

  /** Remove a chunk. */
  removeChunk(id: string): void {
    this.bm25.remove(id);
    this.vectors.delete(id);
  }

  /** Remove all chunks from a file. */
  removeFile(filePath: string): void {
    // BM25 will handle removal; we just clean our vector cache lazily
    this.bm25.removeFile(filePath);
    // Clean known IDs from vector cache
    for (const [id, chunk] of this.bm25["docs"] as Map<string, CodeChunk>) {
      if (chunk.filePath === filePath) this.vectors.delete(id);
    }
  }

  /** Clear everything. */
  clear(): void {
    this.bm25.clear();
    this.vectors.clear();
  }

  /** Number of indexed chunks. */
  get size(): number {
    return this.vectors.size;
  }

  // ── Search ──────────────────────────────────────────────────────────

  /**
   * Hybrid search: run dense (embedding) and sparse (BM25) retrievers
   * in parallel, then fuse results using Reciprocal Rank Fusion.
   */
  async search(query: string): Promise<HybridResult[]> {
    if (this.vectors.size === 0) return [];

    const k = 60; // RRF constant

    // ── Dense retrieval ───────────────────────────────────────────────
    const queryVec = await this.embedder.embed(query);
    const denseResults: { id: string; score: number }[] = [];

    if (queryVec) {
      for (const [id, vec] of this.vectors) {
        const sim = Embedder.cosineSimilarity(queryVec, vec);
        denseResults.push({ id, score: sim });
      }
      denseResults.sort((a, b) => b.score - a.score);
    }

    // ── Sparse retrieval (BM25) ───────────────────────────────────────
    const sparseResults = this.bm25.search(query, this.candidateK);

    // ── Reciprocal Rank Fusion ────────────────────────────────────────
    const fusionScores = new Map<string, {
      denseScore: number;
      sparseScore: number;
      chunk: CodeChunk;
    }>();

    // Add dense ranks
    for (let i = 0; i < denseResults.length; i++) {
      const { id, score } = denseResults[i];
      const bm25Doc = this.bm25["docs"].get(id) as CodeChunk | undefined;
      if (!bm25Doc) continue;

      const rrfScore = 1 / ((i + 1) + k);
      fusionScores.set(id, {
        chunk: bm25Doc,
        denseScore: score,
        sparseScore: 0,
      });
    }

    // Add sparse ranks (RRF fusion)
    for (let i = 0; i < sparseResults.length; i++) {
      const { chunk, score } = sparseResults[i];
      const existing = fusionScores.get(chunk.id);
      const rrfScore = 1 / ((i + 1) + k);

      if (existing) {
        existing.sparseScore = score;
      } else {
        fusionScores.set(chunk.id, {
          chunk,
          denseScore: 0,
          sparseScore: score,
        });
      }
    }

    // Combine: RRF + weighted alpha blend
    const combined: HybridResult[] = [];
    for (const [id, data] of fusionScores) {
      // RRF contribution from dense rank
      let denseRRF = 0;
      const denseIdx = denseResults.findIndex((r) => r.id === id);
      if (denseIdx >= 0) {
        denseRRF = 1 / (denseIdx + 1 + k);
      }

      // RRF contribution from sparse rank
      let sparseRRF = 0;
      const sparseIdx = sparseResults.findIndex((r) => r.chunk.id === id);
      if (sparseIdx >= 0) {
        sparseRRF = 1 / (sparseIdx + 1 + k);
      }

      // Weighted fusion
      const score = this.alpha * denseRRF + (1 - this.alpha) * sparseRRF;

      combined.push({
        chunk: data.chunk,
        score,
        denseScore: data.denseScore,
        sparseScore: data.sparseScore,
      });
    }

    // Sort by combined score descending, limit to topK
    return combined
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK);
  }
}
