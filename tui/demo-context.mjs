// Context longevity demo: simulates a multi-step agent task
// and verifies context accumulates across all iterations.
//
// Run: node demo-context.mjs
//
// This demonstrates that in normal mode (no [SIDE]), every message
// is preserved in the prompt context.

import { ContextManager } from "./dist/agent/context.js";

const cm = new ContextManager();
cm.setSystemPrompt("You are a coding agent.");

// Simulate a 10-step task: agent reads files, thinks, and writes output
cm.addMessage("user", "Your task: analyze all source files and produce a summary.");
console.log("Step  user        →  1 msg  |", cm.getStats());

for (let step = 1; step <= 5; step++) {
  cm.addMessage("assistant", "", {
    toolCalls: [{
      id: `read_${step}`, type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ file_path: `src/file${step}.ts` }) }
    }]
  });
  cm.addToolResult("read_file", true, `// content of file${step}.ts\nconst x = ${step};`, `read_${step}`, {});

  const stats = cm.getStats();
  console.log(`Step  read file${step} → ${stats.total} msgs | total=${stats.total} relevant=${stats.relevant}`);
}

cm.addMessage("assistant", "I've read all files. Here's my analysis... TASK_COMPLETE");
const final = cm.getStats();
console.log(`Step  complete     → ${final.total} msgs | total=${final.total} relevant=${final.relevant}`);

const promptMsgs = cm.getPromptMessages();
console.log(`\nTotal prompt messages: ${promptMsgs.length}`);
console.log(`System prompt:       ${promptMsgs[0] ? "present" : "missing"}`);
console.log(`User message:         ${promptMsgs[1] ? "present" : "missing"}`);

// Verify every step has a corresponding tool call + result in prompt
const toolCalls = promptMsgs.filter(m => m.role === "assistant" && m.tool_calls);
const toolResults = promptMsgs.filter(m => m.role === "tool");
console.log(`Tool call messages:   ${toolCalls.length} (expected 5)`);
console.log(`Tool result messages: ${toolResults.length} (expected 5)`);
console.log(`Final response:       ${promptMsgs[promptMsgs.length - 1].content.slice(0, 50)}...`);

const allContext = toolCalls.length === 5 && toolResults.length === 5 && promptMsgs.length === 13;
console.log(`\n${allContext ? "✓ ALL CONTEXT PRESERVED" : "✗ CONTEXT LOST"}`);
