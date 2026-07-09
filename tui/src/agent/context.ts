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
    private maxHistoryLength = 200,
    private maxMessageLength = 100_000,
    private slidingWindowSize = 30,
  ) {}

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  addMessage(
    role: Message["role"],
    content: string,
    opts?: { toolCallId?: string; toolCalls?: Record<string, unknown>[]; metadata?: Record<string, unknown> },
  ): number {
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
    return this.history.length - 1; // return the index
  }

  addToolResult(
    toolName: string,
    success: boolean,
    content: string,
    toolCallId: string,
    metadata?: Record<string, unknown>,
  ): number {
    const status = success ? "success" : "failed";
    return this.addMessage("tool", `Tool '${toolName}' execution ${status}:\n${content}`, {
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
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      if (msg.role === "assistant" && msg.content !== "") {
        msg.metadata = { ...msg.metadata, irrelevant: true };
        for (let j = i - 1; j >= 0; j--) {
          if (this.history[j].role === "user") {
            this.history[j].metadata = { ...this.history[j].metadata, irrelevant: true };
            return;
          }
        }
        return;
      }
      if (msg.role === "user") {
        msg.metadata = { ...msg.metadata, irrelevant: true };
        return;
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

  /**
   * Apply task-tree-based trimming.
   *
   * Retains:
   * 1. Messages in the active path (current task → subtask)
   * 2. The last `slidingWindowSize` messages (always)
   * 3. Messages from non-compressed completed nodes
   *
   * Everything else is marked as `irrelevant` and excluded from getPromptMessages().
   */
  trimToRetainedIndices(retained: Set<number>): void {
    const lastN = Math.min(this.slidingWindowSize, this.history.length);
    const windowStart = this.history.length - lastN;

    for (let i = 0; i < this.history.length; i++) {
      // Always keep the sliding window tail
      if (i >= windowStart) continue;

      // If not in the retained set → mark irrelevant
      if (!retained.has(i)) {
        this.history[i].metadata = { ...this.history[i].metadata, irrelevant: true };
      }
    }

    // Enforce absolute max history length
    this.trimHistory();
  }

  /** Reset all relevance markings. */
  resetRelevance(): void {
    for (const msg of this.history) {
      if (msg.metadata?.irrelevant) {
        delete msg.metadata.irrelevant;
      }
    }
  }

  getStats(): { total: number; relevant: number } {
    let total = 0;
    let relevant = 0;
    for (const msg of this.history) {
      total++;
      if (!msg.metadata?.irrelevant) {
        relevant++;
      }
    }
    return { total, relevant };
  }

  /** Read a slice of the raw message history. */
  getHistorySlice(start: number, end: number): Message[] {
    return this.history.slice(start, end);
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
