import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ContextManager } from "./context.js";
import { ToolRegistry, SearchCodebaseTool } from "./tools.js";
import { LLMGateway } from "./llm-gateway.js";
import { TaskTracker } from "./task-tracker.js";
import { Planner, type Plan } from "./planner.js";
import { TaskTree } from "./task-tree.js";

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
  /** Enable RAG (hybrid dense+sparse) codebase search. Requires Ollama running locally. */
  enableRag?: boolean;
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
  private ragReady = false;
  private enableRag = false;
  private taskTree: TaskTree;
  private rootTaskId: string | null = null;
  private lastToolCategory: string | null = null;

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
    this.taskTree = new TaskTree();

    const systemPrompt = LLMGateway.formatSystemPrompt();
    this.context.setSystemPrompt(systemPrompt);

    const isSideQuest = opts.objective.startsWith("[SIDE] ");
    const cleanObjective = isSideQuest ? opts.objective.slice(7).trim() : opts.objective;

    // Create root task in the task tree
    const rootTask = this.taskTree.createRootTask(cleanObjective, isSideQuest);
    this.rootTaskId = rootTask.id;

    // Add the user message and extend the task's range
    const msgIdx = this.context.addMessage("user", `Your task: ${cleanObjective}`);
    this.taskTree.extendActiveRange(msgIdx + 1);
    this.taskTree.recordMessages(msgIdx + 1);

    this.emitContextStats();

    // Mark RAG for async init in run() if enabled
    this.enableRag = opts.enableRag ?? false;
    this.ragReady = !this.enableRag;
  }

  async run(): Promise<string> {
    this.log(`Starting agent execution for task: ${this.tracker.state.objective}`);
    this.log(`Max iterations: ${this.maxIterations}`);
    this.log("");

    // ── RAG Initialization (lazy, only if enabled) ─────────────────────
    if (!this.ragReady) {
      await this.initRag();
    }

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

      // Apply task-tree-based context trimming before LLM call
      this.applyContextTrim();

      const messages = this.context.getPromptMessages();
      this.logRequestPrompt(this.tracker.state.iterationCount, messages);
      const toolSchemas = this.toolRegistry.getToolSchemas();
      const { toolCalls, finalResponse, promptTokens } = await this.llm.generateResponse(messages, toolSchemas);
      if (promptTokens !== undefined) this.promptTokens = promptTokens;

      if (finalResponse && finalResponse.startsWith("Error:")) {
        this.log(`LLM Error: ${finalResponse}`);
        this.tracker.addError("LLMError", finalResponse);
        this.trackMessage("assistant", finalResponse);
        this.emitContextStats();
        continue;
      }

      if (finalResponse !== null) {
        if (this.onResponse) {
          this.onResponse(finalResponse);
        } else {
          this.log(finalResponse);
        }
        this.trackMessage("assistant", finalResponse);
        this.emitContextStats();

        // ── Step Completion Detection ──────────────────────────────
        if (this.plan) {
          this.checkStepCompletion(finalResponse);
        }

        if (finalResponse.includes("TASK_COMPLETE") ||
            this.tracker.state.iterationCount >= this.maxIterations - 1
        ) {
          // Mark root task as completed in the task tree
          if (this.rootTaskId) {
            this.taskTree.completeNode(this.rootTaskId);
          }
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

        this.trackMessage("assistant", "", { toolCalls: formattedToolCalls });

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

          const result = await this.toolRegistry.executeToolCall(tc);

          this.trackToolResult(tc.name, result.success, result.content, tc.id, result.metadata as Record<string, unknown>);

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

        // ── Implicit subtask detection via tool pattern ────────────
        this.detectToolCategoryShift(toolCalls);
      }
    }
    return this.tracker.getExecutionSummary();
  }

  // ── Private: Message tracking ────────────────────────────────────────

  /** Add a message to context AND track it in the active task node. */
  private trackMessage(
    role: import("./context.js").Message["role"],
    content: string,
    opts?: { toolCallId?: string; toolCalls?: Record<string, unknown>[]; metadata?: Record<string, unknown> },
  ): number {
    const idx = this.context.addMessage(role, content, opts);
    this.taskTree.extendActiveRange(idx + 1);
    return idx;
  }

  /** Add a tool result to context AND track it. */
  private trackToolResult(
    toolName: string,
    success: boolean,
    content: string,
    toolCallId: string,
    metadata?: Record<string, unknown>,
  ): number {
    const idx = this.context.addToolResult(toolName, success, content, toolCallId, metadata);
    this.taskTree.extendActiveRange(idx + 1);
    return idx;
  }

  /**
   * Compress completed tree nodes and trim the context before each LLM call.
   * Builds human-readable summaries for compressed nodes and inserts them
   * into context so high-level information is preserved.
   */
  private applyContextTrim(): void {
    const compressed = this.taskTree.compressCompletedNodes(1);

    // Build and insert a summary message for each compressed node
    if (compressed.length > 0) {
      const lines: string[] = ["[Compressed: previous completed tasks]"];

      for (const info of compressed) {
        const typeLabel = info.type === "subtask" ? "Step" : "Task";
        const summary = this.buildNodeSummary(
          info.goal,
          info.msgRange,
        );
        lines.push(`  ${typeLabel}: ${info.goal}`);
        if (summary) lines.push(`    ${summary}`);
      }

      this.trackMessage("system", lines.join("\n"));
    }

    const retained = this.taskTree.getRetainedIndices();
    this.context.trimToRetainedIndices(retained);
  }

  /**
   * Scan the context history for a node's message range and build
   * a concise one-line summary of what happened.
   */
  private buildNodeSummary(goal: string, range: [number, number]): string {
    const [start, end] = range;
    if (start >= end) return "";

    const msgs = this.context.getHistorySlice(start, end);
    const toolCalls = new Map<string, number>();
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    let errors = 0;

    for (const msg of msgs) {
      // Count tool calls
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = (tc as any).function?.name ?? "unknown";
          toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
        }
      }
      // Extract file paths from tool results
      if (msg.role === "tool") {
        if (msg.metadata?.file_path) {
          const fp = msg.metadata.file_path as string;
          if (msg.content?.startsWith("Tool 'write_file'")) {
            filesWritten.add(fp);
          } else {
            filesRead.add(fp);
          }
        }
        if (msg.metadata?.command) {
          // shell command — try to extract file refs from the command text
          const cmd = msg.metadata.command as string;
          const fileMatch = cmd.match(/(?:cat|less|head|tail|grep)\s+(\S+)/);
          if (fileMatch) filesRead.add(fileMatch[1]);
        }
        if (msg.metadata?.returncode != null && (msg.metadata.returncode as number) !== 0) {
          errors++;
        }
      }
    }

    const parts: string[] = [];
    if (toolCalls.size > 0) {
      const callSummary = [...toolCalls.entries()]
        .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
        .join(", ");
      parts.push(`Tools: ${callSummary}`);
    }
    if (filesRead.size > 0) {
      parts.push(`Read: ${[...filesRead].slice(0, 5).join(", ")}`);
    }
    if (filesWritten.size > 0) {
      parts.push(`Wrote: ${[...filesWritten].slice(0, 5).join(", ")}`);
    }
    if (errors > 0) {
      parts.push(`${errors} error(s)`);
    }

    return parts.length > 0 ? parts.join(" | ") : "Completed";
  }

  // ── Private: Implicit subtask detection ──────────────────────────────

  /** Tool categories for pattern-based subtask inference. */
  private static toolCategory(name: string, params: Record<string, unknown>): string {
    if (name === "read_file" || name === "search_codebase") return "read";
    if (name === "write_file") return "write";
    if (name === "run_shell") {
      const cmd = (params.command as string) ?? "";
      const low = cmd.toLowerCase();
      if (/\b(pytest?|jest|vitest|check|test)\b/.test(low)) return "test";
      if (/\bgit\b/.test(low) && !/^\s*git/.test(low)) return "shell";
      if (/^\s*git\b/.test(low)) return "git";
      if (/\b(npm|npx|yarn|pnpm|bun)\b/.test(low)) return "install";
      return "shell";
    }
    return "other";
  }

  /**
   * After an iteration's tool calls, detect if the tool usage pattern
   * shifted to a new category. If so, create an implicit subtask.
   *
   * Skips when there's an active plan with planner subtasks — those
   * are tracked by checkStepCompletion instead.
   */
  private detectToolCategoryShift(toolCalls: import("./tools.js").ToolCall[]): void {
    // Don't create implicit subtasks while a planner plan is active
    if (this.plan) return;

    // Determine the dominant category for this iteration
    const categories = toolCalls.map(
      (tc) => Orchestrator.toolCategory(tc.name, tc.parameters),
    );
    const dominant = this.mostFrequent(categories) ?? "other";

    // No change → same implicit subtask continues
    if (dominant === this.lastToolCategory) return;
    this.lastToolCategory = dominant;

    // Category changed → create a new implicit subtask
    const goal = this.describeCategory(dominant);
    const newSubtask = this.taskTree.createSubtask(this.rootTaskId!, goal);
    this.taskTree.activeNodeId = newSubtask.id;
    this.log(`── Implicit subtask: ${goal} ──`);
  }

  /** Describe a tool category in human terms. */
  private describeCategory(cat: string): string {
    const descriptions: Record<string, string> = {
      read: "Read and explore code",
      write: "Write and modify code",
      shell: "Execute shell commands",
      test: "Run tests and verify",
      git: "Version control operations",
      install: "Install dependencies",
      other: "Other operations",
    };
    return descriptions[cat] ?? `Phase: ${cat}`;
  }

  /** Find the most frequent element in an array. */
  private mostFrequent(arr: string[]): string | null {
    if (arr.length === 0) return null;
    const freq = new Map<string, number>();
    let maxCount = 0;
    let maxItem = arr[0];
    for (const item of arr) {
      const c = (freq.get(item) ?? 0) + 1;
      freq.set(item, c);
      if (c > maxCount) {
        maxCount = c;
        maxItem = item;
      }
    }
    return maxItem;
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
    this.trackMessage("system", planMessage);

    // Create subtasks in the tree for each plan step
    for (const step of plan.steps) {
      this.taskTree.createSubtask(this.rootTaskId!, step.description, step.id - 1);
    }
    // Activate the first subtask
    const firstSubtasks = this.taskTree.nodes.get(this.rootTaskId!)?.children;
    if (firstSubtasks && firstSubtasks.length > 0) {
      this.taskTree.activeNodeId = firstSubtasks[0].id;
    }

    // Set initial step context
    const firstStep = plan.steps[0];
    this.trackMessage(
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

    const completedStepIdx = parseInt(stepMatch[1], 10) - 1; // 0-based

    // Mark current subtask as completed
    const rootNode = this.rootTaskId ? this.taskTree.nodes.get(this.rootTaskId) : undefined;
    if (rootNode && completedStepIdx < rootNode.children.length) {
      const subtask = rootNode.children[completedStepIdx];
      this.taskTree.completeNode(subtask.id);
    }

    this.tracker.advanceStep();
    const { currentStep, totalSteps } = this.tracker.state;
    this.onStepChange?.(currentStep, totalSteps);

    if (currentStep <= totalSteps) {
      const nextStep = this.plan.steps[currentStep - 1];

      // Activate the next subtask
      const nextSubtask = rootNode?.children[currentStep - 1];
      if (nextSubtask) {
        this.taskTree.activeNodeId = nextSubtask.id;
      }

      this.trackMessage(
        "user",
        `Proceed to step ${currentStep}/${totalSteps}: ${nextStep.description}`,
      );
      this.log(`--- Step ${currentStep}/${totalSteps}: ${nextStep.description} ---`);
    }
  }

  // ── Private: RAG (codebase search) ──────────────────────────────────

  /**
   * Lazy-initialize the hybrid search index.
   * Scans the project root, builds chunks, embeds them via Ollama,
   * indexes with BM25, and registers the search_codebase tool.
   */
  private async initRag(): Promise<void> {
    this.log("Initializing RAG codebase index...");

    try {
      const { ChunkBuilder } = await import("../rag/chunk-builder.js");
      const { Embedder } = await import("../rag/embedder.js");
      const { BM25Index } = await import("../rag/bm25.js");
      const { HybridSearch } = await import("../rag/hybrid-search.js");

      const builder = new ChunkBuilder();
      await builder.init();

      const files = builder.collectFiles(this.projectRoot);
      this.log(`Found ${files.length} source files for indexing`);

      const allChunks: import("../rag/types.js").CodeChunk[] = [];
      for (const f of files) {
        try {
          const chunks = await builder.build(f);
          allChunks.push(...chunks);
        } catch {
          // skip unparseable files
        }
      }

      if (allChunks.length === 0) {
        this.log("Warning: No chunks could be extracted — RAG disabled.");
        this.ragReady = false;
        return;
      }

      const embedder = new Embedder();
      const bm25 = new BM25Index();
      const hybrid = new HybridSearch(embedder, bm25);
      await hybrid.indexChunks(allChunks);

      // Register the search tool
      this.toolRegistry.register(new SearchCodebaseTool(this.projectRoot, hybrid));

      this.log(`RAG ready: ${allChunks.length} chunks indexed, ${hybrid.size} embedded`);
    } catch (e: any) {
      this.log(`Warning: RAG initialization failed — ${e.message ?? String(e)}. ` +
        `Agent will continue without codebase search. Make sure Ollama is running.`);
    }

    this.ragReady = true;
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
