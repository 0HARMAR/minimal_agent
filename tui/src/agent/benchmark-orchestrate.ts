/**
 * Benchmark: naive vs draft+orchestrate tool execution.
 *
 * Runs identical batches of tool calls two ways:
 *   Naive:        execute each call sequentially as-is
 *   Orchestrated: draft first → skip redundant calls → execute remaining
 *
 * Run: npx tsx src/agent/benchmark-orchestrate.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, ToolCall, ToolOrchestrator } from "./tools.js";

// Reuse the code generator from the stress benchmark
// (inline a minimal version to avoid import issues)
function genCode(name: string, lines: number): string {
  const out: string[] = [
    `// ${name}`,
    `export interface ${name}Options { enabled: boolean; timeout: number; }`,
    `const DEFAULT: ${name}Options = { enabled: true, timeout: 5000 };`,
    `export class ${name} {`,
    `  private opts: ${name}Options;`,
    `  constructor(opts?: Partial<${name}Options>) { this.opts = { ...DEFAULT, ...opts }; }`,
  ];
  for (let i = 0; i < lines; i++) {
    out.push(`  method_${i}(): void { /* ${i} */ }`);
  }
  out.push("}");
  return out.join("\n");
}

let cid = 0;
function tc(name: string, params: Record<string, unknown>): ToolCall {
  return { id: `c${++cid}`, name, parameters: params };
}

// ── Build test project ────────────────────────────────────────────────────

function setupProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  const files: [string, number][] = [
    ["auth", 600], ["api", 500], ["db", 400], ["queue", 300],
    ["cache", 250], ["logger", 150], ["config", 80], ["types", 60],
  ];
  for (const [name, lines] of files) {
    writeFileSync(join(dir, "src", `${name}.ts`), genCode(name, lines), "utf-8");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
}

// ── Build a batch with deliberately redundant patterns ─────────────────────

function buildBatch(): ToolCall[] {
  cid = 0;

  // Simulate what the LLM sends in ONE iteration: multiple interleaved reads,
  // writes, and a shell command — including obvious duplicates.
  return [
    tc("read_file", { file_path: "src/auth.ts" }),
    tc("read_file", { file_path: "src/api.ts" }),
    tc("read_file", { file_path: "src/auth.ts" }),           // duplicate of #1
    tc("write_file", { file_path: "src/new-module.ts", content: genCode("new-module", 40) }),
    tc("search_codebase", { query: "database connection", max_results: 3 }),
    tc("read_file", { file_path: "src/new-module.ts" }),     // read-after-write
    tc("read_file", { file_path: "src/api.ts" }),            // duplicate of #2
    tc("read_file", { file_path: "src/db.ts" }),
    tc("write_file", { file_path: "src/new-module.ts", content: genCode("new-module", 42) }),
    tc("read_file", { file_path: "src/new-module.ts" }),     // read-after-write
    tc("read_file", { file_path: "src/auth.ts" }),           // duplicate of #1
    tc("read_file", { file_path: "src/cache.ts" }),
    tc("run_shell", { command: "ls src/" }),
    tc("run_shell", { command: "ls src/" }),                  // duplicate
    tc("read_file", { file_path: "src/db.ts" }),             // duplicate of #7
    tc("read_file", { file_path: "src/new-module.ts" }),     // read-after-write
    tc("run_shell", { command: "wc -l src/auth.ts" }),
    tc("read_file", { file_path: "src/logger.ts" }),
    tc("read_file", { file_path: "src/queue.ts" }),
    tc("read_file", { file_path: "src/auth.ts" }),           // duplicate of #1
  ];
}

// ── Run naive (no orchestration) ──────────────────────────────────────────

async function runNaive(registry: ToolRegistry, calls: ToolCall[]): Promise<number> {
  const t0 = Date.now();
  for (const call of calls) {
    await registry.executeToolCall(call);
  }
  return Date.now() - t0;
}

// ── Run orchestrated (draft → skip → execute) ─────────────────────────────

async function runOrchestrated(registry: ToolRegistry, calls: ToolCall[]): Promise<{ timeMs: number; skipped: number; draft: any[] }> {
  const orchestrator = new ToolOrchestrator(registry);
  const t0 = Date.now();
  const { results, draft, skipped } = await orchestrator.orchestrate(calls);
  const timeMs = Date.now() - t0;
  return { timeMs, skipped, draft };
}

// ── Main ──────────────────────────────────────────────────────────────────

// Run 3 rounds to get stable averages
const ROUNDS = 3;

async function main() {
  console.log("=".repeat(70));
  console.log("Draft + Orchestrate Benchmark");
  console.log("=".repeat(70));

  const projectDir = mkdtempSync(join(tmpdir(), "orch-bench-"));
  setupProject(projectDir);

  const batch = buildBatch();
  console.log(`\nBatch: ${batch.length} tool calls`);
  console.log(`  read_file:       ${batch.filter(t => t.name === "read_file").length} calls`);
  console.log(`  write_file:      ${batch.filter(t => t.name === "write_file").length} calls`);
  console.log(`  run_shell:       ${batch.filter(t => t.name === "run_shell").length} calls`);
  console.log(`  search_codebase: ${batch.filter(t => t.name === "search_codebase").length} calls`);

  // Analyze what's redundant
  const uniqueReads = new Set(batch.filter(t => t.name === "read_file").map(t => t.parameters.file_path as string));
  const uniqueShells = new Set(batch.filter(t => t.name === "run_shell").map(t => t.parameters.command as string));
  const writeFiles = batch.filter(t => t.name === "write_file").map(t => t.parameters.file_path as string);
  const readsAfterWrite = batch.filter(t => t.name === "read_file" && writeFiles.includes(t.parameters.file_path as string));

  console.log(`\nRedundancy analysis:`);
  console.log(`  Unique files to read:  ${uniqueReads.size} (${batch.filter(t => t.name === "read_file").length - uniqueReads.size} duplicates)`);
  console.log(`  Unique shell commands: ${uniqueShells.size} (${batch.filter(t => t.name === "run_shell").length - uniqueShells.size} duplicates)`);
  console.log(`  Read-after-write:      ${readsAfterWrite.length} opportunities`);

  // Run benchmark rounds
  let naiveTotal = 0;
  let orchTotal = 0;
  let totalSkipped = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    // Fresh registries each round to avoid cross-round cache contamination
    const naiveReg = new ToolRegistry(projectDir);
    const orchReg = new ToolRegistry(projectDir);

    // Warm OS cache: read some files
    for (const call of batch.slice(0, 3)) {
      await naiveReg.executeToolCall(call);
    }

    // Naive run
    const tNaive = await runNaive(naiveReg, batch);
    naiveTotal += tNaive;

    // Orchestrated run
    const { timeMs, skipped, draft } = await runOrchestrated(orchReg, batch);
    orchTotal += timeMs;
    totalSkipped += skipped;

    if (round === 1) {
      console.log(`\n── Round 1 Draft Plan ──`);
      for (const step of draft) {
        const icon = step.action === "execute" ? "  ▶" : "  ⏭";
        const fp = step.call.parameters.file_path ?? step.call.parameters.command ?? "";
        console.log(`  ${icon} ${step.action.padEnd(14)} ${step.call.name.padEnd(18)} ${String(fp).slice(0, 30).padEnd(32)} ${step.reason}`);
      }
    }
  }

  // ── Results ─────────────────────────────────────────────────────────
  const avgNaive = naiveTotal / ROUNDS;
  const avgOrch = orchTotal / ROUNDS;
  const avgSkipped = totalSkipped / ROUNDS;
  const savedMs = avgNaive - avgOrch;
  const savedPct = (savedMs / avgNaive) * 100;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`RESULTS (avg of ${ROUNDS} rounds)`);
  console.log(`${"=".repeat(70)}`);
  console.log(``);
  console.log(`  ${"Metric".padEnd(30)} ${"Naive".padStart(10)} ${"Orchestrated".padStart(14)} ${"Savings".padStart(10)}`);
  console.log(`  ${"─".repeat(28)}  ${"─".repeat(10)}  ${"─".repeat(14)}  ${"─".repeat(10)}`);
  console.log(`  ${"Wall time".padEnd(30)} ${`${avgNaive.toFixed(0)}ms`.padStart(10)} ${`${avgOrch.toFixed(0)}ms`.padStart(14)} ${`${savedMs.toFixed(0)}ms`.padStart(10)}`);
  console.log(`  ${"Speedup".padEnd(30)} ${"".padStart(10)} ${`${(avgNaive / Math.max(1, avgOrch)).toFixed(2)}x`.padStart(14)}`);
  console.log(`  ${"Calls skipped".padEnd(30)} ${"0".padStart(10)} ${`${avgSkipped.toFixed(0)}`.padStart(14)} ${`${((avgSkipped / batch.length) * 100).toFixed(0)}%`.padStart(10)}`);
  console.log(`  ${"Actual executions".padEnd(30)} ${`${batch.length}`.padStart(10)} ${`${(batch.length - avgSkipped).toFixed(0)}`.padStart(14)}`);

  // Breakdown by tool
  console.log(`\n  Per-tool breakdown:`);
  for (const tool of ["read_file", "write_file", "run_shell", "search_codebase"]) {
    const total = batch.filter(t => t.name === tool).length;
    if (total === 0) continue;
    // Estimate naive: each call goes to disk/shell
    // Estimate orchestrated: first unique calls + cache hits
    const unique = tool === "read_file"
      ? new Set(batch.filter(t => t.name === "read_file").map(t => t.parameters.file_path as string)).size
      : tool === "run_shell"
        ? new Set(batch.filter(t => t.name === "run_shell").map(t => t.parameters.command as string)).size
        : total;
    const redundant = total - unique;
    // Add read-after-write savings (batch writes in front of reads)
    const writeFiles = batch.filter(t => t.name === "write_file").map(t => t.parameters.file_path as string);
    const rawReads = batch.filter(t => t.name === "read_file" && writeFiles.includes(t.parameters.file_path as string)).length;
    const actualExec = tool === "read_file" ? unique - rawReads : unique;
    console.log(`    ${tool.padEnd(20)} ${total} calls → ${actualExec} actual exec (skip ${total - actualExec})`);
  }

  console.log(`\n  ${savedPct >= 1 ? `✓ ${savedPct.toFixed(0)}% faster with orchestration` : "∼ Negligible difference (batch too small or OS cache dominant)"}`);
  console.log(`  ${avgSkipped > 0 ? `✓ ${avgSkipped.toFixed(0)}/${batch.length} calls skipped by draft analysis` : ""}`);

  // Cleanup
  rmSync(projectDir, { recursive: true, force: true });
  console.log(`\nDone.`);
}

main().catch(console.error);
