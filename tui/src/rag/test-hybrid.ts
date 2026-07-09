/**
 * End-to-end test for hybrid search (embeddings + BM25).
 *
 * Run: npx tsx src/rag/test-hybrid.ts
 */
import { ChunkBuilder } from "./chunk-builder.js";
import { Embedder } from "./embedder.js";
import { BM25Index } from "./bm25.js";
import { HybridSearch } from "./hybrid-search.js";

const AGENT_DIR = new URL("../agent/", import.meta.url).pathname;

async function main() {
  console.log("=== Initializing chunk builder ===");
  const builder = new ChunkBuilder();
  await builder.init();

  console.log("=== Building chunks from agent source files ===");
  const files = builder.collectFiles(AGENT_DIR);
  console.log(`Found ${files.length} source files`);

  const allChunks: import("./types.js").CodeChunk[] = [];
  for (const f of files) {
    const chunks = await builder.build(f);
    allChunks.push(...chunks);
  }
  console.log(`Total chunks: ${allChunks.length}`);

  // Show a sample
  const sample = allChunks.filter(c => c.type === "function_declaration" || c.type === "class_declaration").slice(0, 5);
  console.log("\nSample top-level declarations:");
  for (const c of sample) {
    console.log(`  [${c.type}] ${c.name}  L${c.startLine}  ${c.filePath.split("/").pop()}`);
  }

  // ── Index with hybrid search ────────────────────────────────────────
  console.log("=== Building hybrid search index ===");
  const embedder = new Embedder();
  console.log(`Embedder: provider=${embedder["provider"]}, model=${embedder["model"]}, baseUrl=${embedder["baseUrl"]}`);
  const bm25 = new BM25Index();
  const hybrid = new HybridSearch(embedder, bm25);

  const start = Date.now();
  await hybrid.indexChunks(allChunks);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Indexed ${hybrid.size} vectors in ${elapsed}s`);

  // ── BM25 stats ──────────────────────────────────────────────────────
  const s = bm25.stats();
  console.log(`BM25: ${s.totalDocs} docs, ${s.vocabSize} terms, avg len ${s.avgDocLength}`);

  // ── Queries ─────────────────────────────────────────────────────────
  const queries = [
    "orchestrator run loop",
    "read file tool",
    "execute shell command",
    "task tracker",
    "generate plan",
    "context manager add message",
  ];

  for (const q of queries) {
    console.log(`\n── Query: "${q}" ──`);
    const results = await hybrid.search(q);
    if (results.length === 0) {
      console.log("  (no results)");
      continue;
    }
    for (const r of results.slice(0, 5)) {
      const f = r.chunk.filePath.split("/").pop() ?? "";
      const parent = r.chunk.parentName ? ` (in ${r.chunk.parentName})` : "";
      const sig = r.chunk.signature ? ` — ${r.chunk.signature.split("\n")[0].slice(0, 60)}` : "";
      console.log(
        `  ${(r.score * 100).toFixed(1)}%  [${r.chunk.type}] ${r.chunk.name}${parent}  ${f}:${r.chunk.startLine}${sig}`
      );
    }
  }

  // ── Compare pure BM25 vs hybrid ─────────────────────────────────────
  console.log("\n\n── Comparison: pure BM25 vs hybrid for 'read file' ──");
  const bm25Results = bm25.search("read file", 5);
  console.log("BM25:");
  for (const r of bm25Results) {
    console.log(`  ${r.score.toFixed(4)}  [${r.chunk.type}] ${r.chunk.name}`);
  }
  console.log("Hybrid:");
  const hybResults = await hybrid.search("read file");
  for (const r of hybResults.slice(0, 5)) {
    console.log(`  ${(r.score * 100).toFixed(1)}%  [${r.chunk.type}] ${r.chunk.name}  dense=${r.denseScore.toFixed(4)} sparse=${r.sparseScore.toFixed(4)}`);
  }
}

main().catch(console.error);
