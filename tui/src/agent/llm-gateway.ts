import OpenAI from "openai";
import type { ToolCall, ToolSchema } from "./tools.js";

// ── types ────────────────────────────────────────────────────────────────

interface GenerateResult {
  toolCalls: ToolCall[] | null;
  finalResponse: string | null;
}

// ── LLMGateway ───────────────────────────────────────────────────────────

export class LLMGateway {
  private client: OpenAI;

  constructor(
    apiKey?: string,
    private model = "deepseek-chat",
    private temperature = 0,
    private maxTokens = 4096,
  ) {
    const key = apiKey ?? process.env["DEEPSEEK_API_KEY"];
    if (!key) {
      throw new Error("API key not provided. Set DEEPSEEK_API_KEY or pass apiKey.");
    }
    this.client = new OpenAI({
      apiKey: key,
      baseURL: "https://api.deepseek.com/v1",
    });
  }

  async generateResponse(
    messages: { role: string; content: string; tool_call_id?: string; tool_calls?: Record<string, unknown>[] }[],
    toolSchemas: ToolSchema[],
  ): Promise<GenerateResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: toolSchemas.length > 0
          ? toolSchemas.map((s) => ({
              type: "function" as const,
              function: s.function,
            }))
          : undefined,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      });

      const message = response.choices[0]?.message;
      if (!message) {
        return { toolCalls: null, finalResponse: "Error: No message in response" };
      }

      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolCalls: ToolCall[] = [];
        for (const tc of message.tool_calls) {
          try {
            const params = JSON.parse(tc.function.arguments);
            toolCalls.push({ id: tc.id, name: tc.function.name, parameters: params });
          } catch {
            return { toolCalls: null, finalResponse: `Error: Invalid JSON in tool call arguments: ${tc.function.arguments}` };
          }
        }
        return { toolCalls, finalResponse: null };
      }

      return { toolCalls: null, finalResponse: message.content?.trim() ?? "" };
    } catch (e: any) {
      return { toolCalls: null, finalResponse: `Error: ${e.message ?? String(e)}` };
    }
  }

  static formatSystemPrompt(base?: string): string {
    return (
      base ??
      `You are a minimal autonomous coding agent. Your purpose is to help users with programming tasks by reading and writing files and executing shell commands.

Follow these rules:
1. Think step by step about how to achieve the user's objective
2. Use the provided tools to interact with the system
3. When you have completed the task, respond with a clear summary of what you did
4. If you encounter errors, explain them and attempt to fix them
5. Do not perform any actions outside the allowed tools
6. Be concise and focus on completing the task efficiently

Available tools:
- read_file: Read a file from the project directory
- write_file: Write content to a file in the project directory
- run_shell: Run a shell command in the project directory

When you are finished with the task, end your response with "TASK_COMPLETE" followed by your final summary.

Context relevance: If the user's request or your internal exploration is a tangential side question not directly related to the main objective, prefix your response with "[IRRELEVANT]" so it won't pollute the conversation context for future iterations. Only use this for truly unrelated side queries or exploratory dead ends.`
    );
  }
}
