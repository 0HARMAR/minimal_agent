import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ContextManager } from "./context.js";
import { ToolRegistry } from "./tools.js";
import { LLMGateway } from "./llm-gateway.js";
import { TaskTracker } from "./task-tracker.js";
import { Planner, type Plan } from "./planner.js";

export interface OrchestratorOpts {
  projectRoot: string;
  objective: string;
  maxIterations?: number;
  modelName?: string;
  apiKey?: string;
  context?: ContextManager;
  onLog: (msg: string) => void;
  onResponse?: (msg: string) => void;
  stopCheck: () => boolean;
  onConfirmBash?: (command: string) => Promise<boolean>;
  onShellOutput?: (command: string, output: string) => void;
  onContextStats?: (stats: { total: number; relevant: number; promptTokens: number }) => void;
  onPlanGenerated?: (plan: Plan) => void;
  onStepChange?: (step: number, total: number) => void;
}

export class Orchestrator {
  private projectRoot: string;
  private maxIterations: number;
  private context: ContextManager;
  private toolRegistry: ToolRegistry;
  private llm: LLMGateway;
  private tracker: TaskTracker;
  private planner: Planner;
  private plan: Plan | null = null;
  private onLog: (msg: string) => void;
  private onResponse?: (msg: string) => void;
  private stopCheck: () => boolean;
  private onConfirmBash?: (command: string) => Promise<boolean>;
  private onShellOutput?: (command: string, output: string) => void;
  private promptTokens = 0;
  private onContextStats?: (stats: { total: number; relevant: number; promptTokens: number }) => void;
  private onPlanGenerated?: (plan: Plan) => void;
  private onStepChange?: (step: number, total: number) => void;

  constructor(opts: OrchestratorOpts) {
    this.projectRoot = opts.projectRoot;
    this.maxIterations = opts.maxIterations ?? parseInt(process.env["MAX_ITERATIONS"] ?? "10", 10);
    this.onLog = opts.onLog;
    this.onResponse = opts.onResponse;
    this.stopCheck = opts.stopCheck;
    this.onConfirmBash = opts.onConfirmBash;
    this.onShellOutput = opts.onShellOutput;
    this.onContextStats = opts.onContextStats;
    this.onPlanGenerated = opts.onPlanGenerated;
    this.onStepChange = opts.onStepChange;

    this.context = opts.context ?? new ContextManager();
    this.toolRegistry = new ToolRegistry(this.projectRoot);
    this.llm = new LLMGateway(opts.apiKey, opts.modelName);
    this.tracker = new TaskTracker(opts.objective, this.maxIterations);
    this.planner = new Planner(this.llm);

    const systemPrompt = LLMGateway.formatSystemPrompt();
    this.context.setSystemPrompt(systemPrompt);

    const isSideQuest = opts.objective.startsWith("[SIDE] ");
    const cleanObjective = isSideQuest ? opts.objective.slice(7).trim() : opts.objective;
    this.context.addMessage("user", `Your task: ${cleanObjective}`);
    this.emitContextStats();
  }

  async run(): Promise<string> {
    this.log(`Starting agent execution for task: ${this.tracker.state.objective}`);
    this.log(`Max iterations: ${this.maxIterations}`);
    this.log("");

    // ── Plan Generation Phase ──────────────────────────────────────────
    const isSideQuest = this.tracker.state.objective.startsWith("[SIDE] ");
    if (!isSideQuest) {
      await this.generateAndInjectPlan();
    }

    // ── Main Execution Loop ────────────────────────────────────────────
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
      this.logRequestPrompt(this.tracker.state.iterationCount, messages);
      const toolSchemas = this.toolRegistry.getToolSchemas();
      const { toolCalls, finalResponse, promptTokens } = await this.llm.generateResponse(messages, toolSchemas);
      if (promptTokens !== undefined) this.promptTokens = promptTokens;

      if (finalResponse && finalResponse.startsWith("Error:")) {
        this.log(`LLM Error: ${finalResponse}`);
        this.tracker.addError("LLMError", finalResponse);
        this.context.addMessage("assistant", finalResponse);
        this.emitContextStats();
        continue;
      }

      if (finalResponse !== null) {
        if (this.onResponse) {
          this.onResponse(finalResponse);
        } else {
          this.log(finalResponse);
        }
        this.context.addMessage("assistant", finalResponse);
        this.emitContextStats();

        // ── Step Completion Detection ──────────────────────────────
        if (this.plan) {
          this.checkStepCompletion(finalResponse);
        }

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
        this.emitContextStats();
      }
    }
    return this.tracker.getExecutionSummary();
  }

  // ── Private: Plan Generation & Injection ─────────────────────────────

  private async generateAndInjectPlan(): Promise<void> {
    this.log("Generating execution plan...");
    const plan = await this.planner.generatePlan(this.tracker.state.objective);

    if (!plan) {
      this.log("Warning: Could not generate plan — proceeding without step-by-step planning.");
      this.log("");
      return;
    }

    this.plan = plan;
    this.tracker.setSteps(plan.steps.length);
    this.onPlanGenerated?.(plan);

    const planMessage = Planner.formatPlanMessage(plan);
    this.context.addMessage("system", planMessage);

    // Set initial step context
    const firstStep = plan.steps[0];
    this.context.addMessage(
      "user",
      `Start with step 1/${plan.steps.length}: ${firstStep.description}`,
    );

    this.log(`Plan generated: ${plan.steps.length} steps`);
    this.onStepChange?.(1, plan.steps.length);
    this.log(`--- Step 1/${plan.steps.length}: ${firstStep.description} ---`);
    this.log("");
  }

  private checkStepCompletion(response: string): void {
    const stepMatch = response.match(/\[STEP\s*(\d+)\s*COMPLETE\]/i);
    if (!stepMatch || !this.plan) return;

    this.tracker.advanceStep();
    const { currentStep, totalSteps } = this.tracker.state;
    this.onStepChange?.(currentStep, totalSteps);

    if (currentStep <= totalSteps) {
      const nextStep = this.plan.steps[currentStep - 1];
      this.context.addMessage(
        "user",
        `Proceed to step ${currentStep}/${totalSteps}: ${nextStep.description}`,
      );
      this.log(`--- Step ${currentStep}/${totalSteps}: ${nextStep.description} ---`);
    }
  }

  // ── Private: Logging / Stats ─────────────────────────────────────────

  private log(msg: string): void {
    this.onLog(msg);
  }

  private logRequestPrompt(_iteration: number, messages: { role: string; content: string }[]): void {
    const concat = messages.map((m) => m.content).join("");
    const logPath = join(this.projectRoot, "request_prompts.log");
    try {
      appendFileSync(logPath, concat + "\n", "utf-8");
    } catch { /* skip */ }
  }

  private emitContextStats(): void {
    const { total, relevant } = this.context.getStats();
    this.onContextStats?.({ total, relevant, promptTokens: this.promptTokens });
  }
}
