import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

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

  constructor(protected projectRoot: string) {
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

      if (!fs.existsSync(abs)) return { success: false, content: `File not found: ${filePath}`, metadata: {} };
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return { success: false, content: `Path is not a file: ${filePath}`, metadata: {} };
      if (stat.size > 10 * 1024 * 1024) {
        return { success: false, content: `File too large: ${filePath} (${stat.size} bytes, max 10MB)`, metadata: {} };
      }

      const content = fs.readFileSync(abs, "utf-8");
      return { success: true, content, metadata: { file_path: filePath, size: content.length } };
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

      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");

      return {
        success: true,
        content: `Successfully wrote ${content.length} characters to ${filePath}`,
        metadata: { file_path: filePath, size: content.length },
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

      const result = execSync(command, {
        cwd: this.projectRoot,
        timeout: 30000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      return { success: true, content: result, metadata: { command, returncode: 0 } };
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

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  constructor(projectRoot: string) {
    this.register(new ReadFileTool(projectRoot));
    this.register(new WriteFileTool(projectRoot));
    this.register(new RunShellTool(projectRoot));
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
    return await tool.run(toolCall.parameters);
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

  constructor(projectRoot: string, hybrid: HybridSearch) {
    super(projectRoot); // projectRoot not used by this tool, but BaseTool requires it
    this.hybrid = hybrid;
  }

  async run(params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const query = (params.query as string)?.trim();
      if (!query) {
        return { success: false, content: "Query cannot be empty", metadata: {} };
      }
      const maxResults = Math.min(Math.max(1, (params.max_results as number) ?? 5), 20);

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

      return {
        success: true,
        content: lines.join("\n"),
        metadata: { query, count: results.length },
      };
    } catch (e: any) {
      return { success: false, content: `Error searching codebase: ${e.message ?? String(e)}`, metadata: {} };
    }
  }
}
