/**
 * Benchmark: tool stats + orchestration (read-after-write buffer).
 *
 * Simulates a realistic agent session and reports:
 *   - Per-tool call count, time, bytes, errors
 *   - Read-after-write buffer hits (disk IO avoided)
 *   - Cache hit rates
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, ToolCall } from "./tools.js";

function makeCall(name: string, params: Record<string, unknown>): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2, 8)}`, name, parameters: params };
}

async function main() {
  console.log("=".repeat(64));
  console.log("Tool Stats & Orchestration Benchmark");
  console.log("=".repeat(64));

  // Set up temp project
  const tmpDir = mkdtempSync(join(tmpdir(), "tools-bench-"));
  const srcDir = join(tmpDir, "src");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(srcDir, { recursive: true });

  // Create some test files
  writeFileSync(join(srcDir, "main.ts"), "export function main() { return 42; }", "utf-8");
  writeFileSync(join(srcDir, "utils.ts"), "export function add(a: number, b: number) { return a + b; }", "utf-8");
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");

  const registry = new ToolRegistry(tmpDir);

  // ── Simulate a realistic agent session ──────────────────────────────
  // Pattern: agent reads files, searches codebase, writes code, reads back, runs tests

  const session: ToolCall[] = [
    // Phase 1: Explore (read + search)
    makeCall("read_file", { file_path: "src/main.ts" }),
    makeCall("read_file", { file_path: "src/utils.ts" }),
    makeCall("read_file", { file_path: "package.json" }),
    makeCall("read_file", { file_path: "src/main.ts" }), // repeat read
    makeCall("read_file", { file_path: "src/utils.ts" }), // repeat read

    // Phase 2: Implement (write)
    makeCall("write_file", { file_path: "src/new-feature.ts", content: "export function feature() { return 'new'; }" }),

    // Phase 3: Verify write (read back what was just written → should hit write buffer)
    makeCall("read_file", { file_path: "src/new-feature.ts" }),

    // Phase 4: More reads
    makeCall("read_file", { file_path: "src/main.ts" }), // repeat
    makeCall("read_file", { file_path: "src/utils.ts" }), // repeat

    // Phase 5: Modify existing file
    makeCall("write_file", { file_path: "src/main.ts", content: "export function main() { return 99; }\nexport function extra() { return 1; }" }),

    // Phase 6: Read modified file back → buffer hit
    makeCall("read_file", { file_path: "src/main.ts" }),

    // Phase 7: More repeat reads
    makeCall("read_file", { file_path: "src/main.ts" }),
    makeCall("read_file", { file_path: "src/new-feature.ts" }),

    // Phase 8: Shell commands
    makeCall("run_shell", { command: "ls src/" }),
    makeCall("run_shell", { command: "cat package.json" }),
    makeCall("run_shell", { command: "ls src/" }), // repeat → cache hit
    makeCall("run_shell", { command: "wc -l src/main.ts" }),
  ];

  console.log(`\nRunning ${session.length} tool calls...`);
  const t0 = Date.now();

  for (const call of session) {
    const result = await registry.executeToolCall(call);
    const meta = result.metadata as Record<string, unknown>;
    const flags = [
      meta?.cached ? "📦cache" : "",
      meta?.fromBuffer ? "📋buffer" : "",
      meta?.deduped ? "⏭dedup" : "",
      !result.success ? "❌err" : "",
    ].filter(Boolean).join(" ");
    console.log(
      `  ${call.name.padEnd(18)} ${(call.parameters.file_path ?? call.parameters.command ?? "").toString().slice(0, 30).padEnd(32)} ${flags}`,
    );
  }

  const totalTime = Date.now() - t0;

  // ── Report ─────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(64)}`);
  console.log(registry.getUsageReport());
  console.log(`${"=".repeat(64)}`);
  console.log(`Session total: ${totalTime}ms (${session.length} calls)`);
  console.log(`Write buffer hits: ${registry.getBufferSize() > 0 ? "active" : "none"}`);
  console.log(`Temp dir: ${tmpDir}`);

  // Cleanup
  import("node:fs").then((fs) => fs.rmSync(tmpDir, { recursive: true, force: true }));
}

main().catch(console.error);
