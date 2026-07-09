/**
 * Benchmark: BM25-only vs Embedding-only vs Hybrid search.
 *
 * Metrics:
 *   Accuracy — Precision@5, Recall@5, MRR, NDCG@5
 *   Efficiency — query latency, index build time
 *
 * Ground truth: file-path-based relevance (chunks from the file that
 * implements the queried concept are considered relevant).
 *
 * Run: npx tsx src/rag/benchmark-search.ts
 */
import { ChunkBuilder } from "./chunk-builder.js";
import { Embedder } from "./embedder.js";
import { BM25Index } from "./bm25.js";
import { HybridSearch } from "./hybrid-search.js";

const AGENT_DIR = new URL("../agent/", import.meta.url).pathname;

// ── Queries with file-based ground truth ───────────────────────────────────

interface BenchmarkQuery {
  q: string;
  /** File paths whose chunks are considered relevant (substring match). */
  relevantFiles: string[];
}

const QUERIES: BenchmarkQuery[] = [
  { q: "read file tool",             relevantFiles: ["tools.ts"] },
  { q: "execute shell command",      relevantFiles: ["tools.ts"] },
  { q: "write output to file",       relevantFiles: ["tools.ts"] },
  { q: "task tracker iteration",     relevantFiles: ["task-tracker.ts"] },
  { q: "generate execution plan",    relevantFiles: ["planner.ts", "orchestrator.ts"] },
  { q: "context add message",        relevantFiles: ["context.ts"] },
  { q: "orchestrator main loop",     relevantFiles: ["orchestrator.ts"] },
  { q: "system prompt format",       relevantFiles: ["llm-gateway.ts"] },
  { q: "task completion status",     relevantFiles: ["task-tracker.ts"] },
  { q: "plan step interface",        relevantFiles: ["planner.ts"] },
];

// ── Metrics ───────────────────────────────────────────────────────────────

interface EvalResult {
  precision5: number;
  recall5: number;
  mrr: number;
  ndcg5: number;
  latencyMs: number;
}

function isRelevant(chunk: { filePath: string }, query: BenchmarkQuery): boolean {
  const fileName = chunk.filePath.split("/").pop() ?? "";
  return query.relevantFiles.some((rf) => fileName === rf);
}

function computeMetrics(
  results: { chunk: { filePath: string }; score: number }[],
  query: BenchmarkQuery,
  totalRelevant: number,
): EvalResult {
  const top5 = results.slice(0, 5);

  // Precision@5
  const relevantInTop5 = top5.filter((r) => isRelevant(r.chunk, query)).length;
  const precision5 = relevantInTop5 / 5;

  // Recall@5
  const recall5 = totalRelevant > 0 ? relevantInTop5 / totalRelevant : 0;

  // MRR
  let mrr = 0;
  for (let i = 0; i < results.length && i < 20; i++) {
    if (isRelevant(results[i].chunk, query)) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  // NDCG@5 (binary relevance)
  let dcg = 0;
  for (let i = 0; i < top5.length; i++) {
    const rel = isRelevant(top5[i].chunk, query) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // log2(2)=1, log2(3)=1.58, ...
  }
  // Ideal DCG: all 5 relevant
  const idcg = 1 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4) + 1 / Math.log2(5) + 1 / Math.log2(6);
  const ndcg5 = idcg > 0 ? dcg / idcg : 0;

  return { precision5, recall5, mrr, ndcg5, latencyMs: 0 };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

// ── Count total relevant per query ────────────────────────────────────────

function countRelevant(chunks: { filePath: string }[], query: BenchmarkQuery): number {
  return chunks.filter((c) => isRelevant(c, query)).length;
}

// ── Main benchmark ─────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(72));
  console.log("Hybrid Search Benchmark — Accuracy & Efficiency");
  console.log("=".repeat(72));

  // Build chunks
  console.log("\n--- Building chunks ---");
  const builder = new ChunkBuilder();
  await builder.init();
  const files = builder.collectFiles(AGENT_DIR);
  const allChunks: import("./types.js").CodeChunk[] = [];
  for (const f of files) {
    const chunks = await builder.build(f);
    allChunks.push(...chunks);
  }
  console.log(`  ${allChunks.length} chunks from ${files.length} files`);

  // Count relevant per query
  console.log("\n--- Ground truth ---");
  for (const q of QUERIES) {
    const n = countRelevant(allChunks, q);
    console.log(`  "${q.q.padEnd(35)}" → ${n} relevant chunks in ${q.relevantFiles.join(", ")}`);
  }

  // Index
  console.log("\n--- Indexing ---");

  const bm25Only = new BM25Index();
  let t0 = Date.now();
  bm25Only.build(allChunks);
  console.log(`  BM25 index:  ${(Date.now() - t0)}ms, ${bm25Only.stats().vocabSize} terms`);

  const embedder = new Embedder();
  const bm25ForHybrid = new BM25Index();
  const hybrid = new HybridSearch(embedder, bm25ForHybrid);
  t0 = Date.now();
  await hybrid.indexChunks(allChunks);
  const indexTime = Date.now() - t0;
  console.log(`  Hybrid index: ${indexTime}ms (incl. embedding), ${hybrid.size} vectors`);

  // Embedding-only: use the same vectors from hybrid but search without BM25
  // We simulate this by creating a HybridSearch with alpha=1.0 (dense only)

  // Run queries
  console.log("\n" + "=".repeat(72));
  console.log("Results");
  console.log("=".repeat(72));

  const header = `${"Query".padEnd(38)} ${"Strategy".padEnd(12)} P@5     R@5     MRR     NDCG@5  Latency`;
  console.log("\n" + header);
  console.log("-".repeat(header.length));

  const summaries: { label: string; prec: number[]; rec: number[]; mrr: number[]; ndcg: number[]; lat: number[] }[] = [];

  for (const method of [
    { label: "BM25", run: (q: string) => runBM25(bm25Only, q) },
    { label: "Dense", run: (q: string) => runDense(embedder, allChunks, q) },
    { label: "Hybrid", run: (q: string) => runHybrid(hybrid, q) },
  ]) {
    const precs: number[] = [];
    const recs: number[] = [];
    const mrrs: number[] = [];
    const ndcgs: number[] = [];
    const lats: number[] = [];

    for (const query of QUERIES) {
      const tStart = Date.now();
      const results = await method.run(query.q);
      const latency = Date.now() - tStart;

      const totalRel = countRelevant(allChunks, query);
      const metrics = computeMetrics(results, query, totalRel);
      metrics.latencyMs = latency;

      precs.push(metrics.precision5);
      recs.push(metrics.recall5);
      mrrs.push(metrics.mrr);
      ndcgs.push(metrics.ndcg5);
      lats.push(metrics.latencyMs);

      const shortQ = query.q.length > 36 ? query.q.slice(0, 33) + "..." : query.q;
      console.log(
        `${shortQ.padEnd(38)} ${method.label.padEnd(12)} ` +
        `${fmtPct(metrics.precision5).padStart(6)} ${fmtPct(metrics.recall5).padStart(6)} ` +
        `${metrics.mrr.toFixed(3).padStart(6)} ${metrics.ndcg5.toFixed(3).padStart(7)} ` +
        `${String(metrics.latencyMs).padStart(5)}ms`,
      );
    }

    summaries.push({ label: method.label, prec: precs, rec: recs, mrr: mrrs, ndcg: ndcgs, lat: lats });
    console.log();
  }

  // ── Final summary table ──────────────────────────────────────────────
  console.log("=".repeat(72));
  console.log("Averages");
  console.log("=".repeat(72));

  const sumHeader = `${"Strategy".padEnd(12)} P@5       R@5       MRR       NDCG@5    Latency   IndexTime`;
  console.log("\n" + sumHeader);
  console.log("-".repeat(sumHeader.length));

  for (const s of summaries) {
    const p = fmtPct(avg(s.prec));
    const r = fmtPct(avg(s.rec));
    const m = avg(s.mrr).toFixed(3);
    const n = avg(s.ndcg).toFixed(3);
    const l = avg(s.lat).toFixed(0);
    console.log(
      `${s.label.padEnd(12)} ` +
      `${p.padStart(7)}  ${r.padStart(7)}  ` +
      `${m.padStart(7)}  ${n.padStart(7)}  ` +
      `${l.padStart(6)}ms  ` +
      `${s.label === "Hybrid" ? String(indexTime).padStart(5) + "ms" : "  N/A    "}`,
    );
  }

  // ── Best strategy per query ──────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("Head-to-head: which strategy wins Precision@5 per query");
  console.log("=".repeat(72));

  for (let i = 0; i < QUERIES.length; i++) {
    const scores = summaries.map((s) => s.prec[i]);
    const bm25P = scores[0];
    const denseP = scores[1];
    const hybridP = scores[2];

    let winner: string;
    if (hybridP >= bm25P && hybridP >= denseP) winner = "Hybrid";
    else if (bm25P >= denseP) winner = "BM25";
    else winner = "Dense";

    const note = hybridP >= bm25P && hybridP >= denseP ? " ←" : "";
    console.log(
      `  "${QUERIES[i].q.padEnd(35)}"  ` +
      `BM25=${fmtPct(bm25P)}  Dense=${fmtPct(denseP)}  ` +
      `Hybrid=${fmtPct(hybridP)}  →  ${winner}${note}`,
    );
  }

  console.log("\nDone.");
}

  // ── Strategy runners ───────────────────────────────────────────────────

function runBM25(bm25: BM25Index, query: string) {
  return bm25.search(query, 10).map((r) => ({ chunk: r.chunk, score: r.score }));
}

async function runHybrid(hybrid: HybridSearch, query: string) {
  return (await hybrid.search(query)).map((r) => ({ chunk: r.chunk, score: r.score }));
}

/**
 * Dense-only runner using the cached vectors from HybridSearch.
 * We build a second HybridSearch with alpha=1.0 that shares the same
 * vector store by copying the index data.
 */
async function runDense(
  embedder: Embedder,
  allChunks: import("./types.js").CodeChunk[],
  query: string,
): Promise<{ chunk: import("./types.js").CodeChunk; score: number }[]> {
  const qVec = await embedder.embed(query);
  if (!qVec) return [];

  // Re-embed all chunks (expensive but correct for benchmark)
  // Optimization: embed in batch
  const batchSize = 20;
  const scored: { chunk: import("./types.js").CodeChunk; score: number }[] = [];

  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);
    const results = await embedder.embedBatch(batch);
    for (const r of results) {
      const sim = Embedder.cosineSimilarity(qVec, r.vector);
      scored.push({ chunk: r.chunk, score: sim });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 10);
}

main().catch(console.error);
