import { ContextManager } from "./context.js";
import { ToolRegistry } from "./tools.js";
import { LLMGateway } from "./llm-gateway.js";
import { TaskTracker } from "./task-tracker.js";

export interface OrchestratorOpts {
  projectRoot: string;
  objective: string;
  maxIterations?: number;
  modelName?: string;
  apiKey?: string;
  onLog: (msg: string) => void;
  stopCheck: () => boolean;
  onConfirmBash?: (command: string) => Promise<boolean>;
  onShellOutput?: (command: string, output: string) => void;
}

export class Orchestrator {
  private projectRoot: string;
  private maxIterations: number;
  private context: ContextManager;
  private toolRegistry: ToolRegistry;
  private llm: LLMGateway;
  private tracker: TaskTracker;
  private onLog: (msg: string) => void;
  private stopCheck: () => boolean;
  private onConfirmBash?: (command: string) => Promise<boolean>;
  private onShellOutput?: (command: string, output: string) => void;

  constructor(opts: OrchestratorOpts) {
    this.projectRoot = opts.projectRoot;
    this.maxIterations = opts.maxIterations ?? parseInt(process.env["MAX_ITERATIONS"] ?? "10", 10);
    this.onLog = opts.onLog;
    this.stopCheck = opts.stopCheck;
    this.onConfirmBash = opts.onConfirmBash;
    this.onShellOutput = opts.onShellOutput;

    this.context = new ContextManager();
    this.toolRegistry = new ToolRegistry(this.projectRoot);
    this.llm = new LLMGateway(opts.apiKey, opts.modelName);
    this.tracker = new TaskTracker(opts.objective, this.maxIterations);

    const systemPrompt = LLMGateway.formatSystemPrompt();
    this.context.setSystemPrompt(systemPrompt);
    this.context.addMessage("user", `Your task: ${opts.objective}`);
  }

  async run(): Promise<string> {
    this.log(`Starting agent execution for task: ${this.tracker.state.objective}`);
    this.log(`Max iterations: ${this.maxIterations}`);
    this.log("");

    while (true) {
      if (this.stopCheck()) {
        this.tracker.markCompleted("Stopped by user", "Task stopped by user request.");
        this.log("Stop requested — terminating.");
        break;
      }

      const { terminate, reason } = this.tracker.shouldTerminate();
      if (terminate) {
        this.tracker.markCompleted(reason!, `Task terminated: ${reason}`);
        break;
      }

      this.tracker.incrementIteration();

      const messages = this.context.getPromptMessages();
      const toolSchemas = this.toolRegistry.getToolSchemas();
      const { toolCalls, finalResponse } = await this.llm.generateResponse(messages, toolSchemas);

      // Handle LLM error
      if (finalResponse && finalResponse.startsWith("Error:")) {
        this.log(`LLM Error: ${finalResponse}`);
        this.tracker.addError("LLMError", finalResponse);
        this.context.addMessage("assistant", finalResponse);
        continue;
      }

      // Handle final text response
      if (finalResponse !== null) {
        this.log(finalResponse);
        this.context.addMessage("assistant", finalResponse);

        if (
          finalResponse.includes("TASK_COMPLETE") ||
          this.tracker.state.iterationCount >= this.maxIterations - 1
        ) {
          const clean = finalResponse.replace("TASK_COMPLETE", "").trim();
          this.tracker.markCompleted("Task completed successfully", clean);
          break;
        }
        continue;
      }

      // Handle tool calls
      if (toolCalls) {
        const formattedToolCalls = toolCalls.map((tc) => {
          return {
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.parameters),
            },
          };
        });

        this.context.addMessage("assistant", "", { toolCalls: formattedToolCalls });

        for (const tc of toolCalls) {
          if (tc.name === "run_shell" && this.onConfirmBash) {
            const allowed = await this.onConfirmBash(tc.parameters.command as string);
            if (!allowed) {
              this.context.addToolResult(
                tc.name, false, "User denied shell command execution", tc.id, {},
              );
              continue;
            }
          }

          const result = this.toolRegistry.executeToolCall(tc);

          this.context.addToolResult(tc.name, result.success, result.content, tc.id, result.metadata as Record<string, unknown>);

          if (tc.name === "run_shell") {
            const out = result.content.trim();
            if (out && this.onShellOutput) {
              this.onShellOutput(tc.parameters.command as string, out);
            }
          }

          if (!result.success) {
            this.tracker.addError(`ToolError:${tc.name}`, result.content.slice(0, 200));
          }
        }
      }
    }
    return this.tracker.getExecutionSummary();
  }

  private log(msg: string): void {
    this.onLog(msg);
  }
}
