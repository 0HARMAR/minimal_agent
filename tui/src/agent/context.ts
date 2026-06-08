export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
}

export interface PromptMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Record<string, unknown>[];
}

export class ContextManager {
  private history: Message[] = [];
  private systemPrompt: string | null = null;

  constructor(
    private maxHistoryLength = Number.MAX_SAFE_INTEGER,
    private maxMessageLength = Number.MAX_SAFE_INTEGER,
  ) {}

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  addMessage(
    role: Message["role"],
    content: string,
    opts?: { toolCallId?: string; toolCalls?: Record<string, unknown>[]; metadata?: Record<string, unknown> },
  ): void {
    if (content.length > this.maxMessageLength) {
      content = content.slice(0, this.maxMessageLength) +
        `\n[Truncated - original length: ${content.length} characters]`;
    }

    this.history.push({
      role,
      content,
      tool_call_id: opts?.toolCallId,
      tool_calls: opts?.toolCalls,
      metadata: opts?.metadata ?? {},
    });

    this.trimHistory();
  }

  addToolResult(
    toolName: string,
    success: boolean,
    content: string,
    toolCallId: string,
    metadata?: Record<string, unknown>,
  ): void {
    const status = success ? "success" : "failed";
    this.addMessage("tool", `Tool '${toolName}' execution ${status}:\n${content}`, {
      toolCallId,
      metadata,
    });
  }

  private trimHistory(): void {
    if (this.history.length > this.maxHistoryLength) {
      const first = this.history.slice(0, 1);
      this.history = first.concat(this.history.slice(-(this.maxHistoryLength - 1)));
    }
  }

  markIrrelevant(): void {
    let foundAssistant = false;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      if (!foundAssistant && msg.role === "assistant" && msg.content !== "") {
        msg.metadata = { ...msg.metadata, irrelevant: true };
        foundAssistant = true;
      } else if (foundAssistant && msg.role === "user") {
        msg.metadata = { ...msg.metadata, irrelevant: true };
        break;
      }
    }
  }

  getPromptMessages(): PromptMessage[] {
    const messages: PromptMessage[] = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    for (const msg of this.history) {
      if (msg.metadata?.irrelevant) continue;
      const m: PromptMessage = { role: msg.role, content: msg.content };
      if (msg.tool_call_id) m.tool_call_id = msg.tool_call_id;
      if (msg.tool_calls) m.tool_calls = msg.tool_calls;
      messages.push(m);
    }
    return messages;
  }

  clear(): void {
    this.history = [];
  }

  serialize(): Record<string, unknown> {
    return {
      systemPrompt: this.systemPrompt,
      maxHistoryLength: this.maxHistoryLength,
      maxMessageLength: this.maxMessageLength,
      history: this.history.map((m) => ({ ...m })),
    };
  }
}
