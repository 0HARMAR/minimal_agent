/**
 * Embedding service — transforms text into dense vectors.
 *
 * Supports multiple backends:
 * - Ollama (local, default): http://localhost:11434/api/embed
 * - OpenAI-compatible API:  https://api.openai.com/v1/embeddings
 *
 * Backend auto-detection:
 * - If `provider` is "openai" or `apiKey` is set → OpenAI format
 * - Otherwise → Ollama format
 *
 * Environment variable overrides:
 *   EMBEDDING_PROVIDER  = "ollama" | "openai"
 *   EMBEDDING_API_KEY   = "sk-..."
 *   EMBEDDING_BASE_URL  = "https://api.openai.com/v1"  (or OpenAI-compatible)
 *   EMBEDDING_MODEL     = "text-embedding-3-small" | "nomic-embed-text"
 */

import type { CodeChunk } from "./types.js";

export interface EmbeddingResult {
  chunk: CodeChunk;
  vector: number[];
}

export type EmbeddingProvider = "ollama" | "openai";

export interface EmbedderOpts {
  /** Backend provider (default: "ollama"). */
  provider?: EmbeddingProvider;
  /** Base URL (Ollama: http://localhost:11434, OpenAI: https://api.openai.com/v1) */
  baseUrl?: string;
  /** Embedding model name */
  model?: string;
  /** API key (required for OpenAI, ignored for Ollama) */
  apiKey?: string;
  /** Max chunk length in characters; longer chunks are truncated before embedding */
  maxChunkLength?: number;
}

/** Default dimensions for common embedding models */
export const EMBED_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export const DEFAULT_DIM = 768;

export const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

export class Embedder {
  private provider: EmbeddingProvider;
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private maxChunkLength: number;

  constructor(opts: EmbedderOpts = {}) {
    // Resolve provider from env or opts
    const envProvider = process.env["EMBEDDING_PROVIDER"] as EmbeddingProvider | undefined;
    this.provider = opts.provider ?? envProvider ?? "ollama";

    // Resolve base URL
    const envBase = process.env["EMBEDDING_BASE_URL"];
    if (this.provider === "openai") {
      this.baseUrl = opts.baseUrl ?? envBase ?? "https://api.openai.com/v1";
    } else {
      this.baseUrl = opts.baseUrl ?? envBase ?? "http://localhost:11434";
    }

    // Resolve model
    const envModel = process.env["EMBEDDING_MODEL"];
    this.model = opts.model ?? envModel ?? (
      this.provider === "openai" ? DEFAULT_OPENAI_MODEL : "nomic-embed-text"
    );

    // Resolve API key (always from env for security)
    this.apiKey = opts.apiKey ?? process.env["EMBEDDING_API_KEY"] ?? process.env["OPENAI_API_KEY"];

    this.maxChunkLength = opts.maxChunkLength ?? 4096;

    if (this.provider === "openai" && !this.apiKey) {
      console.warn("Embedder: OpenAI provider selected but no API key found. Set EMBEDDING_API_KEY or OPENAI_API_KEY.");
    }
  }

  // ── Public API ───────────────────────────────────────────────────────

  /** Embed a single text string. Returns null on failure. */
  async embed(text: string): Promise<number[] | null> {
    const truncated = text.length > this.maxChunkLength
      ? text.slice(0, this.maxChunkLength)
      : text;

    try {
      if (this.provider === "openai") {
        return await this.embedOpenAI([truncated]).then(r => r[0] ?? null);
      }
      // Ollama path
      const resp = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncated }),
      });
      if (!resp.ok) { await this.logError(resp, "Ollama"); return null; }
      const data = (await resp.json()) as { embeddings?: number[][] };
      return data.embeddings?.[0] ?? null;
    } catch (err) {
      console.error(`Embedder (${this.provider}): ${err}`);
      return null;
    }
  }

  /** Embed a batch of chunks. Falls back to single embedding on batch failure. */
  async embedBatch(chunks: CodeChunk[]): Promise<EmbeddingResult[]> {
    if (chunks.length === 0) return [];

    const maxLen = Math.min(this.maxChunkLength, 4096);
    const texts = chunks.map((c) =>
      c.content.length > maxLen ? c.content.slice(0, maxLen) : c.content,
    );

    // Try batch
    try {
      let vectors: (number[] | null)[];

      if (this.provider === "openai") {
        vectors = await this.embedOpenAI(texts);
      } else {
        vectors = await this.embedOllamaBatch(texts);
      }

      if (vectors.length > 0) {
        const results: EmbeddingResult[] = [];
        for (let i = 0; i < Math.min(chunks.length, vectors.length); i++) {
          if (vectors[i]) {
            results.push({ chunk: chunks[i], vector: vectors[i]! });
          }
        }
        if (results.length === chunks.length) return results;
        if (results.length > 0) console.warn(`Embedder: ${chunks.length - results.length} chunks failed in batch`);
      }
    } catch (err) {
      console.error(`Embedder batch (${this.provider}): ${err}`);
    }

    // Fallback: one at a time
    console.warn("Embedder batch failed — falling back to single embeddings");
    const results: EmbeddingResult[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const vec = await this.embed(chunks[i].content);
      if (vec) results.push({ chunk: chunks[i], vector: vec });
      if (i > 0 && i % 20 === 0) console.log(`  embedded ${i}/${chunks.length}...`);
    }
    return results;
  }

  /** Cosine similarity between two vectors. */
  static cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Get the expected embedding dimension for the current model. */
  get dimension(): number {
    return EMBED_DIMS[this.model] ?? DEFAULT_DIM;
  }

  // ── Private backends ────────────────────────────────────────────────

  /**
   * OpenAI-compatible /v1/embeddings.
   * Input can be a string or array of strings.
   */
  private async embedOpenAI(inputs: string[]): Promise<(number[] | null)[]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs.length === 1 ? inputs[0] : inputs,
        encoding_format: "float",
      }),
    });

    if (!resp.ok) {
      await this.logError(resp, "OpenAI");
      return inputs.map(() => null);
    }

    const data = (await resp.json()) as {
      data: { index: number; embedding: number[] }[];
    };

    // OpenAI returns unordered array indexed by `index`
    const results: (number[] | null)[] = new Array(inputs.length).fill(null);
    for (const item of data.data) {
      if (item.index < results.length) {
        results[item.index] = item.embedding;
      }
    }
    return results;
  }

  /**
   * Ollama /api/embed batch.
   */
  private async embedOllamaBatch(inputs: string[]): Promise<(number[] | null)[]> {
    const resp = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: inputs }),
    });

    if (!resp.ok) {
      await this.logError(resp, "Ollama");
      return inputs.map(() => null);
    }

    const data = (await resp.json()) as { embeddings?: number[][] };
    if (!data.embeddings) return inputs.map(() => null);
    return data.embeddings.map((v) => v);
  }

  private async logError(resp: Response, label: string): Promise<void> {
    const body = await resp.text().catch(() => "(unreadable)");
    console.error(`Embedder (${label}): HTTP ${resp.status} — ${body.slice(0, 200)}`);
  }
}
