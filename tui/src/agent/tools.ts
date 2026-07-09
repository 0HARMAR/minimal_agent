import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { ToolCache, isReadonlyCommand } from "./cache.js";

// ── types ────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  content: string;
  metadata: Record<string, unknown>;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// ── abstract base ────────────────────────────────────────────────────────

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract parameters: Record<string, { type: string; description: string; required?: boolean }>;

  constructor(
    protected projectRoot: string,
    protected cache: ToolCache,
  ) {
    this.projectRoot = path.resolve(projectRoot);
    if (!fs.existsSync(this.projectRoot)) {
      throw new Error(`Project root ${this.projectRoot} does not exist`);
    }
  }

  abstract run(parameters: Record<string, unknown>): ToolResult | Promise<ToolResult>;

  toSchema(): ToolSchema {
    const required: string[] = [];
    const properties: Record<string, { type: string; description: string }> = {};

    for (const [key, val] of Object.entries(this.parameters)) {
      if (val.required) required.push(key);
      const { required: _, ...rest } = val;
      properties[key] = rest;
    }

    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties, required },
      },
    };
  }

  protected validatePath(filePath: string): string {
    const abs = path.resolve(this.projectRoot, filePath);
    const root = this.projectRoot.endsWith(path.sep)
      ? this.projectRoot
      : this.projectRoot + path.sep;
    if (!abs.startsWith(root)) {
      throw new Error(`Path traversal detected: ${filePath} is outside project root`);
    }
    return abs;
  }
}

// ── ReadFile ─────────────────────────────────────────────────────────────

export class ReadFileTool extends BaseTool {
  name = "read_file";
  description = "Read the contents of a file from the project directory";
  parameters = {
    file_path: {
      type: "string",
      description: "Relative path to the file from project root",
      required: true,
    },
  };

  run(params: Record<string, unknown>): ToolResult {
    try {
      const filePath = params.file_path as string;
      const abs = this.validatePath(filePath);

      // Check cache first
      {
        const cached = this.cache.get<string>(abs);
        if (cached !== undefined) {
          return {
            success: true,
            content: cached,
            metadata: { file_path: filePath, size: cached.length, cached: true },
          };
        }
      }

      if (!fs.existsSync(abs)) return { success: false, content: `File not found: ${filePath}`, metadata: {} };
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return { success: false, content: `Path is not a file: ${filePath}`, metadata: {} };
      if (stat.size > 10 * 1024 * 1024) {
        return { success: false, content: `File too large: ${filePath} (${stat.size} bytes, max 10MB)`, metadata: {} };
      }

      const content = fs.readFileSync(abs, "utf-8");

      // Cache with mtime staleness check
      this.cache.set(abs, content, 300_000, { sourceMtime: stat.mtimeMs, label: abs, byteSize: content.length });

      return { success: true, content, metadata: { file_path: filePath, size: content.length, cached: false } };
    } catch (e: any) {
      return { success: false, content: `Error reading file: ${e.message}`, metadata: {} };
    }
  }
}

// ── WriteFile ────────────────────────────────────────────────────────────

export class WriteFileTool extends BaseTool {
  name = "write_file";
  description = "Write content to a file in the project directory (overwrites existing files)";
  parameters = {
    file_path: {
      type: "string",
      description: "Relative path to the file from project root",
      required: true,
    },
    content: {
      type: "string",
      description: "Content to write to the file",
      required: true,
    },
  };

  run(params: Record<string, unknown>): ToolResult {
    try {
      const filePath = params.file_path as string;
      const content = params.content as string;
      const abs = this.validatePath(filePath);

      // Content dedup: skip write if file already has the exact same content
      if (fs.existsSync(abs)) {
        try {
          const existing = fs.readFileSync(abs, "utf-8");
          if (existing === content) {
            // Also invalidate read cache so future reads pick up any mtime change
            this.cache.invalidate(abs);
            return {
              success: true,
              content: `File ${filePath} unchanged — content identical, write skipped`,
              metadata: { file_path: filePath, size: content.length, deduped: true },
            };
          }
        } catch {
          // If we can't read existing, just proceed with write
        }
      }

      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");

      // Invalidate read cache for this file
      this.cache.invalidate(abs);

      return {
        success: true,
        content: `Successfully wrote ${content.length} characters to ${filePath}`,
        metadata: { file_path: filePath, size: content.length, deduped: false },
      };
    } catch (e: any) {
      return { success: false, content: `Error writing file: ${e.message}`, metadata: {} };
    }
  }
}

// ── RunShell ─────────────────────────────────────────────────────────────

export class RunShellTool extends BaseTool {
  name = "run_shell";
  description =
    "Run a shell command in the project directory. " +
    "The user will be prompted to approve each command before it executes. " +
    "Pipes (|) and output redirection (>, >>) are allowed.";
  parameters = {
    command: {
      type: "string",
      description: "Shell command to execute (user must approve before execution)",
      required: true,
    },
  };

  run(params: Record<string, unknown>): ToolResult {
    try {
      const command = (params.command as string).trim();
      if (!command) return { success: false, content: "Empty command", metadata: {} };

      // Cache hit for readonly commands
      if (isReadonlyCommand(command)) {
        const cached = this.cache.get<string>(command);
        if (cached !== undefined) {
          return {
            success: true,
            content: cached,
            metadata: { command, returncode: 0, cached: true },
          };
        }
      }

      const result = execSync(command, {
        cwd: this.projectRoot,
        timeout: 30000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const output = result ?? "";

      // Cache readonly command output (TTL: 30s for commands, so repeated grep/find
      // within the same iteration benefit; long enough for agent loop)
      if (isReadonlyCommand(command)) {
        this.cache.set(command, output, 30_000, { byteSize: output.length });
      }

      return { success: true, content: output, metadata: { command, returncode: 0, cached: false } };
    } catch (e: any) {
      const stderr = e.stderr || "";
      const status = e.status ?? 1;
      return {
        success: false,
        content: `Command failed with exit code ${status}\nStderr: ${stderr}`,
        metadata: { command: params.command as string, returncode: status },
      };
    }
  }
}

// ── ToolRegistry ─────────────────────────────────────────────────────────

export interface ToolCallStats {
  name: string;
  callCount: number;
  totalTimeMs: number;
  totalBytes: number;
  errors: number;
  avgTimeMs: number;
}

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();
  readonly cache: ToolCache;

  // Per-tool call statistics
  private stats = new Map<string, { count: number; totalMs: number; totalBytes: number; errors: number }>();

  // Read-after-write buffer: written content kept in memory for immediate reads
  private writeBuffer = new Map<string, { content: string; writtenAt: number }>();
  private static readonly WRITE_BUFFER_TTL = 60_000; // 1 min

  constructor(projectRoot: string) {
    this.cache = new ToolCache({ label: "tools", maxSize: 200, defaultTtlMs: 60_000 });
    this.register(new ReadFileTool(projectRoot, this.cache));
    this.register(new WriteFileTool(projectRoot, this.cache));
    this.register(new RunShellTool(projectRoot, this.cache));
  }

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
  }

  getToolSchemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.toSchema());
  }

  async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        success: false,
        content: `Tool ${toolCall.name} not found. Available: ${[...this.tools.keys()].join(", ")}`,
        metadata: {},
      };
    }

    // ── Read-after-write optimization ──────────────────────────────
    if (toolCall.name === "read_file") {
      const filePath = toolCall.parameters.file_path as string;
      if (filePath) {
        const buffered = this.writeBuffer.get(filePath);
        if (buffered && Date.now() - buffered.writtenAt < ToolRegistry.WRITE_BUFFER_TTL) {
          // Content was just written; return from memory, skip disk IO entirely
          this.recordStat(toolCall.name, 0, buffered.content.length, false);
          return {
            success: true,
            content: buffered.content,
            metadata: { file_path: filePath, size: buffered.content.length, fromBuffer: true },
          };
        }
      }
    }

    // ── Execute with timing ───────────────────────────────────────
    const t0 = Date.now();
    const result = await tool.run(toolCall.parameters);
    const elapsed = Date.now() - t0;

    const byteSize = (result.content?.length ?? 0);
    this.recordStat(toolCall.name, elapsed, byteSize, !result.success);

    // ── Track writes for read-after-write buffer ──────────────────
    if (toolCall.name === "write_file" && result.success) {
      const filePath = toolCall.parameters.file_path as string;
      const content = toolCall.parameters.content as string;
      if (filePath) {
        this.writeBuffer.set(filePath, { content, writtenAt: Date.now() });
      }
    }

    // ── Cache hit tracking in metadata ────────────────────────────
    if (toolCall.name === "read_file" && result.metadata?.cached) {
      this.recordCacheHit("read_file");
    }
    if (toolCall.name === "run_shell" && result.metadata?.cached) {
      this.recordCacheHit("run_shell");
    }

    return result;
  }

  // ── Stats ─────────────────────────────────────────────────────────

  private statRecords = new Map<string, number>(); // tool → cacheHitCount

  private recordStat(name: string, ms: number, bytes: number, isError: boolean): void {
    let s = this.stats.get(name);
    if (!s) {
      s = { count: 0, totalMs: 0, totalBytes: 0, errors: 0 };
      this.stats.set(name, s);
    }
    s.count++;
    s.totalMs += ms;
    s.totalBytes += bytes;
    if (isError) s.errors++;
  }

  private recordCacheHit(name: string): void {
    this.statRecords.set(name, (this.statRecords.get(name) ?? 0) + 1);
  }

  /** Get per-tool stats snapshot. */
  getToolStats(): ToolCallStats[] {
    return [...this.stats.entries()]
      .map(([name, s]) => ({
        name,
        callCount: s.count,
        totalTimeMs: s.totalMs,
        totalBytes: s.totalBytes,
        errors: s.errors,
        avgTimeMs: s.count > 0 ? Math.round(s.totalMs / s.count) : 0,
      }))
      .sort((a, b) => b.totalTimeMs - a.totalTimeMs); // most expensive first
  }

  /** Get cache hit counts. */
  getCacheStats(): { tool: string; hits: number }[] {
    return [...this.statRecords.entries()]
      .map(([tool, hits]) => ({ tool, hits }))
      .sort((a, b) => b.hits - a.hits);
  }

  /** Get read-after-write buffer size. */
  getBufferSize(): number {
    // Prune expired entries
    const now = Date.now();
    for (const [key, val] of this.writeBuffer) {
      if (now - val.writtenAt > ToolRegistry.WRITE_BUFFER_TTL) {
        this.writeBuffer.delete(key);
      }
    }
    return this.writeBuffer.size;
  }

  /**
   * Return a human-readable summary of tool usage for the log.
   */
  getUsageReport(): string {
    const lines: string[] = ["── Tool Usage Report ──"];
    const toolStats = this.getToolStats();
    if (toolStats.length === 0) return "";

    // Total
    const totalCalls = toolStats.reduce((s, t) => s + t.callCount, 0);
    const totalTime = toolStats.reduce((s, t) => s + t.totalTimeMs, 0);
    const totalBytes = toolStats.reduce((s, t) => s + t.totalBytes, 0);
    const totalErrors = toolStats.reduce((s, t) => s + t.errors, 0);

    lines.push(`  Total: ${totalCalls} calls, ${totalTime}ms, ${(totalBytes / 1024).toFixed(0)}KB, ${totalErrors} errors`);
    lines.push(`  Top by time:`);

    for (const t of toolStats.slice(0, 5)) {
      const pct = totalTime > 0 ? ((t.totalTimeMs / totalTime) * 100).toFixed(0) : "0";
      lines.push(
        `    ${t.name.padEnd(20)} ${String(t.callCount).padStart(4)} calls ` +
        `${String(t.totalTimeMs).padStart(6)}ms (${pct}%) ` +
        `avg ${t.avgTimeMs}ms/call ` +
        `${t.errors > 0 ? `⚠ ${t.errors} err` : ""}`,
      );
    }

    // Cache hits
    const cacheHits = this.getCacheStats();
    if (cacheHits.length > 0) {
      lines.push(`  Cache hits: ${cacheHits.map((c) => `${c.tool}=${c.hits}`).join(", ")}`);
    }

    // Write buffer
    const bufSize = this.getBufferSize();
    if (bufSize > 0) {
      lines.push(`  Write buffer: ${bufSize} files in memory`);
    }

    return lines.join("\n") + "\n";
  }
}

// ── SearchCodebase ─────────────────────────────────────────────────────────

import type { HybridSearch } from "../rag/hybrid-search.js";

export class SearchCodebaseTool extends BaseTool {
  name = "search_codebase";
  description =
    "Search the project codebase using hybrid (embedding + BM25) retrieval. " +
    "Use this when you need to find relevant code — functions, classes, interfaces, " +
    "or files — related to a specific concept, symbol, or question. " +
    "Results include the chunk type, file path, line range, and code content.";
  parameters = {
    query: {
      type: "string",
      description: "The search query — describe what you're looking for in natural language",
      required: true,
    },
    max_results: {
      type: "number",
      description: "Maximum results to return (default: 5, max: 20)",
      required: false,
    },
  };

  private hybrid: HybridSearch;

  constructor(projectRoot: string, hybrid: HybridSearch, cache: ToolCache) {
    super(projectRoot, cache); // projectRoot not used by this tool, but BaseTool requires it
    this.hybrid = hybrid;
  }

  async run(params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const query = (params.query as string)?.trim();
      if (!query) {
        return { success: false, content: "Query cannot be empty", metadata: {} };
      }
      const maxResults = Math.min(Math.max(1, (params.max_results as number) ?? 5), 20);

      // Check cache
      const cacheKey = `search:${query}:${maxResults}`;
      const cached = this.cache.get<string>(cacheKey);
      if (cached !== undefined) {
        return {
          success: true,
          content: cached,
          metadata: { query, count: 0, cached: true },
        };
      }

      const results = await this.hybrid.search(query);

      if (results.length === 0) {
        return { success: true, content: `No results found for: "${query}"`, metadata: { query, count: 0 } };
      }

      const lines: string[] = [
        `Search results for: "${query}"`,
        `Found ${results.length} relevant code chunks:\n`,
      ];

      for (const r of results.slice(0, maxResults)) {
        const f = r.chunk.filePath.split("/").pop() ?? r.chunk.filePath;
        const parent = r.chunk.parentName ? ` (in ${r.chunk.parentName})` : "";
        const sig = r.chunk.signature ? `\n       Signature: ${r.chunk.signature.split("\n")[0]}` : "";
        lines.push(
          `  ── ${r.chunk.type} ${r.chunk.name}${parent} ──`,
          `     File: ${f}:${r.chunk.startLine}-${r.chunk.endLine}`,
          `     Relevance: ${(r.score * 100).toFixed(0)}%${sig}`,
          `     Code:`,
          ...r.chunk.content.split("\n").slice(0, 15).map((l) => `       │ ${l}`),
        );
        if (r.chunk.content.split("\n").length > 15) {
          lines.push(`       │ … (${r.chunk.content.split("\n").length - 15} more lines)`);
        }
        lines.push("");
      }

      const output = lines.join("\n");

      // Cache search result (short TTL — codebase may change between iterations)
      this.cache.set(cacheKey, output, 15_000, { byteSize: output.length });

      return {
        success: true,
        content: output,
        metadata: { query, count: results.length, cached: false },
      };
    } catch (e: any) {
      return { success: false, content: `Error searching codebase: ${e.message ?? String(e)}`, metadata: {} };
    }
  }
}

// ── ToolOrchestrator ───────────────────────────────────────────────────────

export interface DraftStep {
  call: ToolCall;
  action: "execute" | "skip_cache" | "skip_buffer" | "skip_dedup";
  reason: string;
  result?: ToolResult;
}

/**
 * Batch tool call orchestrator with draft-then-execute strategy.
 *
 * 1. Draft: analyze a batch of tool calls to detect redundant patterns
 * 2. Skip: mark calls that can be served from cache/buffer/dedup
 * 3. Execute: run only the remaining calls
 */
export class ToolOrchestrator {
  constructor(private registry: ToolRegistry) {}

  /**
   * Analyze a batch of tool calls and return an optimized execution plan.
   * Does NOT execute anything — purely a "draft" pass.
   */
  draft(calls: ToolCall[]): DraftStep[] {
    const steps: DraftStep[] = [];
    const seenReads = new Set<string>();
    const seenShells = new Set<string>();
    const writtenByBatch = new Map<string, string>(); // filePath → content for write-then-read within same batch

    for (const call of calls) {
      const name = call.name;

      if (name === "read_file") {
        const fp = call.parameters.file_path as string;

        // Rule 1: same file read twice in this batch → skip after first
        if (seenReads.has(fp)) {
          steps.push({ call, action: "skip_cache", reason: `Duplicate read of ${fp} within batch` });
          continue;
        }

        // Rule 2: file was just written in this batch → serve from memory
        if (writtenByBatch.has(fp)) {
          steps.push({
            call,
            action: "skip_buffer",
            reason: `Read-after-write: ${fp} was just written in this batch`,
            result: {
              success: true,
              content: writtenByBatch.get(fp)!,
              metadata: { file_path: fp, fromBuffer: true, orchestrated: true },
            },
          });
          seenReads.add(fp);
          continue;
        }

        // Rule 3: already in cache from previous iterations → no need to plan, cache handles it
        // (this is handled by execute() at runtime)
        seenReads.add(fp);
        steps.push({ call, action: "execute", reason: "First read in batch" });
        continue;
      }

      if (name === "write_file") {
        const fp = call.parameters.file_path as string;
        const content = call.parameters.content as string;

        // Track for read-after-write detection within this batch
        writtenByBatch.set(fp, content);

        // Rule 4: same content already on disk → skip write
        // (handled by the tool's dedup at execute time, but we can flag it)
        steps.push({ call, action: "execute", reason: "Write (dedup checked at runtime)" });
        continue;
      }

      if (name === "run_shell") {
        const cmd = (call.parameters.command as string).trim();

        // Rule 5: same readonly command twice in this batch → skip after first
        if (isReadonlyCommand(cmd) && seenShells.has(cmd)) {
          steps.push({ call, action: "skip_cache", reason: `Duplicate readonly command within batch` });
          continue;
        }

        seenShells.add(cmd);
        steps.push({ call, action: "execute", reason: "Execute" });
        continue;
      }

      // search_codebase, etc — always execute (cache handles it internally)
      steps.push({ call, action: "execute", reason: "Execute" });
    }

    return steps;
  }

  /**
   * Execute a batch according to the draft plan.
   * Returns results for ALL calls (including skipped ones).
   */
  async orchestrate(calls: ToolCall[]): Promise<{ results: ToolResult[]; draft: DraftStep[]; skipped: number }> {
    const draft = this.draft(calls);
    const results: ToolResult[] = [];
    let skipped = 0;

    for (const step of draft) {
      if (step.action === "execute") {
        const result = await this.registry.executeToolCall(step.call);
        results.push(result);
      } else {
        // Return pre-computed or synthetic result for skipped calls
        skipped++;
        if (step.result) {
          results.push(step.result);
        } else {
          results.push({
            success: true,
            content: `[Skipped by orchestrator: ${step.reason}]`,
            metadata: { orchestrated: true, skipReason: step.reason },
          });
        }
      }
    }

    return { results, draft, skipped };
  }
}
