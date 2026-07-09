/**
 * Smoke test — parse a real source file (orchestrator.ts).
 *
 * Run with: npx tsx src/rag/test.ts
 */
import { ChunkBuilder } from "./chunk-builder.js";
import { ChunkStore } from "./chunk-store.js";

async function main() {
  const builder = new ChunkBuilder();
  await builder.init();

  const store = new ChunkStore();

  // Test 1: parse orchestrator.ts
  const orcPath = new URL("../agent/orchestrator.ts", import.meta.url).pathname;
  console.log(`\n=== Parsing: ${orcPath}`);
  let chunks = await builder.build(orcPath);
  store.addAll(chunks);

  console.log(`Chunks: ${chunks.length}`);
  for (const c of chunks) {
    const parent = c.parentName ? ` (in ${c.parentName})` : "";
    const sig = c.signature ? ` — ${c.signature.split("\n")[0].slice(0, 80)}` : "";
    console.log(`  [${c.type}] ${c.name}${parent}  L${c.startLine}-${c.endLine}${sig}`);
  }

  // Test 2: parse the planner
  const planPath = new URL("../agent/planner.ts", import.meta.url).pathname;
  console.log(`\n=== Parsing: ${planPath}`);
  chunks = await builder.build(planPath);
  store.addAll(chunks);

  console.log(`Chunks: ${chunks.length}`);
  for (const c of chunks) {
    const parent = c.parentName ? ` (in ${c.parentName})` : "";
    const sig = c.signature ? ` — ${c.signature.split("\n")[0].slice(0, 80)}` : "";
    console.log(`  [${c.type}] ${c.name}${parent}  L${c.startLine}-${c.endLine}${sig}`);
  }

  // Test 3: parse tools.ts
  const toolsPath = new URL("../agent/tools.ts", import.meta.url).pathname;
  console.log(`\n=== Parsing: ${toolsPath}`);
  chunks = await builder.build(toolsPath);
  store.addAll(chunks);

  console.log(`Chunks: ${chunks.length}`);
  for (const c of chunks) {
    const parent = c.parentName ? ` (in ${c.parentName})` : "";
    const sig = c.signature ? ` — ${c.signature.split("\n")[0].slice(0, 80)}` : "";
    console.log(`  [${c.type}] ${c.name}${parent}  L${c.startLine}-${c.endLine}${sig}`);
  }

  // Test 4: search the store
  console.log(`\n=== Store stats: ${store.size} chunks from ${store.getSymbols().length} symbols`);
  console.log(`\nSearch results for "orchestrator":`);
  for (const r of store.search("orchestrator", 5)) {
    console.log(`  (score ${r.score}) ${r.chunks[0].name} — ${r.chunks[0].type}`);
  }
  console.log(`\nSearch results for "planner":`);
  for (const r of store.search("planner", 5)) {
    console.log(`  (score ${r.score}) ${r.chunks[0].name} — ${r.chunks[0].type}`);
  }
  console.log(`\nSearch results for "run_shell":`);
  for (const r of store.search("run_shell", 5)) {
    console.log(`  (score ${r.score}) ${r.chunks[0].name} — ${r.chunks[0].type}`);
  }
}

main().catch(console.error);
