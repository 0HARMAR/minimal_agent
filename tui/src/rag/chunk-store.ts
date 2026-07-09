/**
 * In-memory chunk store for RAG.
 *
 * Indexes code chunks by file path, chunk type, symbol name, and provides
 * simple search and retrieval for the agent loop to consume.
 */

import type { CodeChunk, ChunkType } from "./types.js";

export interface ChunkSearchResult {
  chunks: CodeChunk[];
  score: number;
}

export class ChunkStore {
  /** All chunks, keyed by id. */
  private byId = new Map<string, CodeChunk>();

  /** Index: filePath → chunk ids. */
  private byFile = new Map<string, Set<string>>();

  /** Index: ChunkType → chunk ids. */
  private byType = new Map<ChunkType, Set<string>>();

  /** Index: lowercase symbol name → chunk ids. */
  private byName = new Map<string, Set<string>>();

  /** Total count of stored chunks. */
  get size(): number {
    return this.byId.size;
  }

  // ── Mutators ──────────────────────────────────────────────────────────

  /** Add a single chunk to the store. */
  add(chunk: CodeChunk): void {
    if (this.byId.has(chunk.id)) return; // deduplicate
    this.byId.set(chunk.id, chunk);

    // Index by file
    this.getOrCreateSet(this.byFile, chunk.filePath).add(chunk.id);

    // Index by type
    this.getOrCreateSet(this.byType, chunk.type).add(chunk.id);

    // Index by name (lowercase)
    const key = chunk.name.toLowerCase();
    this.getOrCreateSet(this.byName, key).add(chunk.id);

    // Also index by parts of the name for prefix/fuzzy matching
    for (const part of chunk.name.split(/[._/-]/)) {
      if (part.length >= 2) {
        this.getOrCreateSet(this.byName, part.toLowerCase()).add(chunk.id);
      }
    }
  }

  /** Add multiple chunks at once. */
  addAll(chunks: CodeChunk[]): void {
    for (const c of chunks) this.add(c);
  }

  /** Remove all chunks from a given file. */
  removeFile(filePath: string): void {
    const ids = this.byFile.get(filePath);
    if (!ids) return;
    for (const id of ids) {
      const chunk = this.byId.get(id);
      if (!chunk) continue;
      this.byId.delete(id);

      // Clean type index
      const typeSet = this.byType.get(chunk.type);
      typeSet?.delete(id);
      if (typeSet?.size === 0) this.byType.delete(chunk.type);

      // Clean name index
      const nameKey = chunk.name.toLowerCase();
      const nameSet = this.byName.get(nameKey);
      nameSet?.delete(id);
      if (nameSet?.size === 0) this.byName.delete(nameKey);
    }
    this.byFile.delete(filePath);
  }

  /** Replace chunks for a file (remove old, add new). */
  setFile(filePath: string, chunks: CodeChunk[]): void {
    this.removeFile(filePath);
    this.addAll(chunks);
  }

  /** Clear all chunks. */
  clear(): void {
    this.byId.clear();
    this.byFile.clear();
    this.byType.clear();
    this.byName.clear();
  }

  // ── Lookups ───────────────────────────────────────────────────────────

  /** Get a single chunk by its id. */
  get(id: string): CodeChunk | undefined {
    return this.byId.get(id);
  }

  /** Get all chunks belonging to a file. */
  getFile(filePath: string): CodeChunk[] {
    const ids = this.byFile.get(filePath);
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)!);
  }

  /** Get all chunks of a given type. */
  getByType(type: ChunkType): CodeChunk[] {
    const ids = this.byType.get(type);
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)!);
  }

  /** Get all chunks. */
  getAll(): CodeChunk[] {
    return [...this.byId.values()];
  }

  // ── Search ────────────────────────────────────────────────────────────

  /**
   * Simple keyword-based search over chunk names and file paths.
   * Returns results sorted by relevance (exact name match → prefix match → file match).
   */
  search(query: string, maxResults = 10): ChunkSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const scored: Map<string, { chunk: CodeChunk; score: number }> = new Map();

    // 1. Exact name match (highest score)
    const exactSet = this.byName.get(q);
    if (exactSet) {
      for (const id of exactSet) {
        const chunk = this.byId.get(id)!;
        scored.set(id, { chunk, score: 100 + (chunk.parentId ? 5 : 0) });
      }
    }

    // 2. Partial name match (contains query)
    for (const [key, ids] of this.byName) {
      if (key.includes(q) && key !== q) {
        for (const id of ids) {
          if (!scored.has(id)) {
            const chunk = this.byId.get(id)!;
            const score = 80 - Math.abs(key.length - q.length);
            scored.set(id, { chunk, score: Math.max(score, 10) });
          }
        }
      }
    }

    // 3. File path match
    for (const [filePath, ids] of this.byFile) {
      const lowerPath = filePath.toLowerCase();
      if (lowerPath.includes(q)) {
        for (const id of ids) {
          if (!scored.has(id)) {
            const chunk = this.byId.get(id)!;
            scored.set(id, { chunk, score: 50 });
          }
        }
      }
    }

    // Sort by score descending, limit
    return [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => ({ chunks: [s.chunk], score: s.score }));
  }

  /**
   * Get all symbols (function names, class names, etc.) indexed in the store,
   * optionally filtered by type.
   */
  getSymbols(type?: ChunkType): string[] {
    const names = new Set<string>();
    const chunks = type ? this.getByType(type) : this.getAll();
    for (const c of chunks) {
      names.add(c.name);
    }
    return [...names].sort();
  }

  // ── Private ───────────────────────────────────────────────────────────

  private getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
    let s = map.get(key);
    if (!s) {
      s = new Set();
      map.set(key, s);
    }
    return s;
  }

  /** Serialize for debugging / inspection. */
  serialize(): Record<string, unknown> {
    return {
      size: this.byId.size,
      files: this.byFile.size,
      types: [...this.byType.entries()].map(([t, ids]) => ({ type: t, count: ids.size })),
      symbols: this.getSymbols().slice(0, 50),
    };
  }
}
