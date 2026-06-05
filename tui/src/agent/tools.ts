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

  abstract run(parameters: Record<string, unknown>): ToolResult;

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

  executeToolCall(toolCall: ToolCall): ToolResult {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        success: false,
        content: `Tool ${toolCall.name} not found. Available: ${[...this.tools.keys()].join(", ")}`,
        metadata: {},
      };
    }
    return tool.run(toolCall.parameters);
  }
}
