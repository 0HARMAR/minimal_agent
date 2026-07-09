/**
 * Benchmark: sliding window vs hybrid task tree context management.
 *
 * Runs the same synthetic conversation through both strategies and reports:
 *   - message retention count
 *   - character count (proxy for tokens)
 *   - information density (active task / total)
 *   - key fact retention rate
 *
 * Run: npx tsx src/agent/context-benchmark.ts
 */
import { ContextManager } from "./context.js";
import { TaskTree } from "./task-tree.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function chars(msgs: { content: string }[]): number {
  return msgs.reduce((s, m) => s + m.content.length, 0);
}

function countByRole(msgs: { role: string }[], role: string): number {
  return msgs.filter((m) => m.role === role).length;
}

function summarize(
  label: string,
  msgs: { role: string; content: string }[],
  activeChars: number,
): void {
  const totalChars = chars(msgs);
  const density = totalChars > 0 ? ((activeChars / totalChars) * 100).toFixed(1) : "N/A";
  console.log(
    `  ${label.padEnd(10)} ${String(msgs.length).padStart(4)} msgs, ` +
    `${String(totalChars).padStart(7)} chars, ` +
    `density ${density}%`,
  );
}

// ── Build a realistic synthetic conversation ───────────────────────────────

interface ScenarioStep {
  role: string;
  content: string;
  meta?: Record<string, unknown>;
}

function buildConversation(): ScenarioStep[] {
  const steps: ScenarioStep[] = [];

  // Task A: Explore codebase (3 iterations)
  steps.push({ role: "user", content: "Your task: Understand how tools.ts works" });
  steps.push({ role: "assistant", content: "I'll read tools.ts to understand the tool pattern." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "read_file" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'read_file' execution success:\nimport * as fs...", meta: { file_path: "tools.ts" } });
  steps.push({ role: "assistant", content: "I see the BaseTool pattern. Let me also read a related file." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "read_file" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'read_file' execution success:\nexport interface ToolCall...", meta: { file_path: "tools.ts" } });
  steps.push({ role: "assistant", content: "Now I understand the structure. [STEP 1 COMPLETE]" });

  // Task A: Implement (2 iterations)
  steps.push({ role: "user", content: "Proceed to step 2: implement the new tool" });
  steps.push({ role: "assistant", content: "I'll write the implementation." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "write_file" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'write_file' execution success:\nWrote 500 chars", meta: { file_path: "tools.ts" } });
  steps.push({ role: "assistant", content: "Implementation complete. [STEP 2 COMPLETE] TASK_COMPLETE" });

  // Task B: Debug a different file (another root task, 4 iterations)
  steps.push({ role: "user", content: "Your task: Find and fix the bug in context.ts" });
  steps.push({ role: "assistant", content: "I'll search the codebase for issues." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "search_codebase" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'search_codebase' execution success:\nFound ContextManager class..." });
  steps.push({ role: "assistant", content: "Found the ContextManager. Let me read it." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "read_file" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'read_file' execution success:\nexport class ContextManager...", meta: { file_path: "context.ts" } });
  steps.push({ role: "assistant", content: "I see the bug: history overflow not handled. [STEP 1 COMPLETE]" });
  steps.push({ role: "user", content: "Proceed to step 2: fix the bug" });
  steps.push({ role: "assistant", content: "Writing the fix now." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "write_file" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'write_file' execution success:\nFixed overflow in context.ts", meta: { file_path: "context.ts" } });
  steps.push({ role: "assistant", content: "Bug was in trimHistory(). [STEP 2 COMPLETE] TASK_COMPLETE" });

  // Task C: Side question (1 iteration)
  steps.push({ role: "user", content: "Your task: [SIDE] What is the max file size allowed?" });
  steps.push({ role: "assistant", content: "From the code: 10MB for read_file." });
  steps.push({ role: "assistant", content: "That's the limit. SIDE_COMPLETE" });

  // Task D: Add tests (ongoing active task, 3 iterations so far)
  steps.push({ role: "user", content: "Your task: Add unit tests for the task tree" });
  steps.push({ role: "assistant", content: "Let me first read the task-tree.ts to understand the API." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "read_file" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'read_file' execution success:\nexport class TaskTree...", meta: { file_path: "task-tree.ts" } });
  steps.push({ role: "assistant", content: "I see the API. Now writing tests." });
  steps.push({ role: "assistant", content: "", meta: { tool_calls: [{ function: { name: "write_file" } }] } satisfies any });
  steps.push({ role: "tool", content: "Tool 'write_file' execution success:\nWrote test file with 800 chars", meta: { file_path: "task-tree.test.ts" } });

  return steps;
}

// ── Strategy 1: Sliding window only ───────────────────────────────────────

function simulateSlidingWindow(conversation: ScenarioStep[], windowSize = 30): { msgs: { role: string; content: string }[]; activeChars: number } {
  const ctx = new ContextManager(200, 100_000, windowSize);

  // Track active task range (approximate: last user message onwards)
  let lastUserIdx = 0;

  for (const step of conversation) {
    const idx = ctx.addMessage(step.role as any, step.content, step.meta as any);
    if (step.role === "user") lastUserIdx = idx;
  }

  // Sliding window: mark everything before the window as irrelevant
  const lastN = Math.min(windowSize, ctx["history"].length);
  const windowStart = ctx["history"].length - lastN;
  for (let i = 0; i < ctx["history"].length; i++) {
    if (i < windowStart) {
      ctx["history"][i].metadata = { ...ctx["history"][i].metadata, irrelevant: true };
    }
  }

  const promptMsgs = ctx.getPromptMessages();
  const activeStartIdx = Math.max(lastUserIdx, windowStart);
  const activeChars = promptMsgs
    .filter((_, i) => {
      // approximate: messages after the last user-initiated task that are in the prompt
      return true; // simplified — count all
    })
    .reduce((s, m) => s + m.content.length, 0);

  // Actually compute active chars more accurately
  let activeTotal = 0;
  for (const msg of ctx["history"]) {
    if (msg.metadata?.irrelevant) continue;
    // Everything still in prompt is "active" for sliding window
    activeTotal += msg.content.length;
  }

  return { msgs: promptMsgs, activeChars: activeTotal };
}

// ── Strategy 2: Hybrid task tree + sliding window ─────────────────────────

function simulateHybrid(
  conversation: ScenarioStep[],
  windowSize = 30,
): { msgs: { role: string; content: string }[]; activeChars: number } {
  const ctx = new ContextManager(200, 100_000, windowSize);
  const tree = new TaskTree();
  let rootTaskId: string | null = null;
  let activeNodeId: string | null = null;

  for (const step of conversation) {
    const idx = ctx.addMessage(step.role as any, step.content, step.meta as any);

    // Track active range
    if (activeNodeId) {
      const node = tree.nodes.get(activeNodeId);
      if (node) node.msgRange = [node.msgRange[0], idx + 1];
    }

    // Create root tasks on user messages
    if (step.role === "user") {
      const isSide = step.content.includes("[SIDE]");
      const root = tree.createRootTask(step.content.slice(0, 80), isSide);
      rootTaskId = root.id;
      activeNodeId = root.id;
      root.msgRange = [idx, idx + 1];

      // Create implicit subtask for tool calls that follow
      if (!isSide) {
        const subtask = tree.createSubtask(root.id, "Execute task");
        activeNodeId = subtask.id;
        subtask.msgRange = [idx, idx + 1];
      }
    }

    // Mark completion
    if (step.content.includes("TASK_COMPLETE") && rootTaskId) {
      tree.completeNode(rootTaskId);
    }
    if (step.content.includes("SIDE_COMPLETE") && rootTaskId) {
      tree.completeNode(rootTaskId);
    }
  }

  // Apply hybrid trim
  const compressed = tree.compressCompletedNodes(1);
  if (compressed.length > 0) {
    ctx.addMessage("system", `[Compressed: ${compressed.map((c) => c.goal).join(", ")}]`);
  }
  const retained = tree.getRetainedIndices();
  ctx.trimToRetainedIndices(retained);

  // Compute active chars (from active path in the tree)
  const activePath = tree.getActivePath();
  let activeChars = 0;
  for (const node of activePath) {
    for (let i = node.msgRange[0]; i < node.msgRange[1]; i++) {
      const msg = ctx["history"][i];
      if (msg && !msg.metadata?.irrelevant) {
        activeChars += msg.content.length;
      }
    }
  }

  return { msgs: ctx.getPromptMessages(), activeChars };
}

// ── Key fact retention test ────────────────────────────────────────────────

function testFactRetention(
  strategy: string,
  conversation: ScenarioStep[],
  facts: { keyword: string; description: string }[],
  simulateFn: (conv: ScenarioStep[]) => { msgs: { role: string; content: string }[]; activeChars: number },
): { retained: number; total: number; pct: string } {
  const { msgs } = simulateFn(conversation);
  const allText = msgs.map((m) => m.content).join(" ");
  let retained = 0;
  for (const fact of facts) {
    if (allText.includes(fact.keyword)) retained++;
  }
  return {
    retained,
    total: facts.length,
    pct: ((retained / facts.length) * 100).toFixed(0),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const conversation = buildConversation();
  const totalSteps = conversation.length;

  console.log("=".repeat(70));
  console.log("Context Management Benchmark");
  console.log("=".repeat(70));
  console.log(`\nConversation: ${totalSteps} messages across 4 tasks\n`);

  // ── Metric 1: Retention & Density ────────────────────────────────────
  console.log("── Metric 1: Message & Token Retention ──");

  const sliding = simulateSlidingWindow(conversation, 30);
  summarize("Sliding", sliding.msgs, sliding.activeChars);

  const hybrid = simulateHybrid(conversation, 30);
  summarize("Hybrid", hybrid.msgs, hybrid.activeChars);

  const slidingChars = chars(sliding.msgs);
  const hybridChars = chars(hybrid.msgs);
  const reduction = slidingChars > 0
    ? (((slidingChars - hybridChars) / slidingChars) * 100).toFixed(1)
    : "N/A";
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Reduction: ${reduction}% fewer characters in context`);
  console.log(`  Density ratio: ${(hybrid.activeChars / Math.max(1, hybridChars) * 100).toFixed(1)}% (hybrid) vs ${(sliding.activeChars / Math.max(1, slidingChars) * 100).toFixed(1)}% (sliding)`);

  // ── Metric 2: Key Fact Retention ─────────────────────────────────────
  console.log(`\n── Metric 2: Key Fact Retention ──`);

  const facts = [
    { keyword: "10MB", description: "Read file size limit" },
    { keyword: "ContextManager", description: "Bug location" },
    { keyword: "task-tree.ts", description: "File tested in Task D" },
    { keyword: "BaseTool", description: "Pattern from Task A" },
    { keyword: "trimHistory", description: "Bug description" },
  ];

  const slidingFacts = testFactRetention("Sliding", conversation, facts, (c) => simulateSlidingWindow(c, 30));
  console.log(`  Sliding: ${slidingFacts.retained}/${slidingFacts.total} facts retained (${slidingFacts.pct}%)`);

  const hybridFacts = testFactRetention("Hybrid", conversation, facts, (c) => simulateHybrid(c, 30));
  console.log(`  Hybrid:  ${hybridFacts.retained}/${hybridFacts.total} facts retained (${hybridFacts.pct}%)`);

  // ── Metric 3: Compression Ratio ──────────────────────────────────────
  console.log(`\n── Metric 3: Compression ──`);
  const compressionRatio = totalSteps > 0
    ? (totalSteps / Math.max(1, hybrid.msgs.length)).toFixed(1)
    : "N/A";
  console.log(`  Original: ${totalSteps} msgs → Hybrid: ${hybrid.msgs.length} msgs (${compressionRatio}x)`);
  console.log(`  Original: ${totalSteps} msgs → Sliding: ${sliding.msgs.length} msgs (${(totalSteps / Math.max(1, sliding.msgs.length)).toFixed(1)}x)`);

  // ── Metric 4: Active Task Focus ──────────────────────────────────────
  console.log(`\n── Metric 4: Active Task Focus ──`);
  const activeSliding = countByRole(sliding.msgs, "tool");
  const activeHybrid = countByRole(hybrid.msgs, "tool");
  console.log(`  Tool messages in context: ${activeSliding} (sliding) vs ${activeHybrid} (hybrid)`);
  console.log(`  (Fewer old tool messages = less noise for LLM)`);

  console.log("\n" + "=".repeat(70));
  console.log("Benchmark complete.");
}

main();
