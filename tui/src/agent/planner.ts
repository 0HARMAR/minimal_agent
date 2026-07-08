import { LLMGateway } from "./llm-gateway.js";

// ── types ────────────────────────────────────────────────────────────────

export interface PlanStep {
  id: number;
  description: string;
  expectedOutcome: string;
}

export interface Plan {
  objective: string;
  steps: PlanStep[];
}

// ── Planner ──────────────────────────────────────────────────────────────

export class Planner {
  private llm: LLMGateway;

  constructor(llm: LLMGateway) {
    this.llm = llm;
  }

  /**
   * Generate a structured step-by-step plan for the given objective.
   * Returns null if planning fails (LLM error, unparseable response, etc.).
   */
  async generatePlan(objective: string): Promise<Plan | null> {
    const messages = [
      { role: "system" as const, content: LLMGateway.PLANNER_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content:
          `Objective: ${objective}\n\n` +
          `Analyze this task and produce a step-by-step plan. ` +
          `Return ONLY valid JSON with no extra explanation.`,
      },
    ];

    const { finalResponse, promptTokens } = await this.llm.generateResponse(messages, []);

    if (!finalResponse || finalResponse.startsWith("Error:")) {
      return null;
    }

    const json = this.extractJSON(finalResponse);
    if (!json) return null;

    try {
      const parsed = JSON.parse(json);
      const rawSteps = parsed.steps || [];
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

      const steps: PlanStep[] = rawSteps.map((s: any, i: number) => ({
        id: s.id ?? i + 1,
        description: s.description || s.task || s.action || `Step ${i + 1}`,
        expectedOutcome: s.expectedOutcome || s.outcome || s.result || "",
      }));

      return { objective, steps };
    } catch {
      return null;
    }
  }

  /**
   * Build the plan message that gets injected into agent context.
   */
  static formatPlanMessage(plan: Plan): string {
    const stepLines = plan.steps
      .map((s) => `Step ${s.id}: ${s.description}`)
      .join("\n");

    return (
      `## Execution Plan\n` +
      `You will complete the following steps in order. ` +
      `After finishing each step, include [STEP n COMPLETE] in your response ` +
      `(where n is the step number) so the system knows to advance. ` +
      `When all steps are done, include TASK_COMPLETE.\n\n` +
      `${stepLines}`
    );
  }

  /**
   * Extract a JSON object from the LLM response text.
   * Tries markdown code block first, then raw JSON brace match.
   */
  private extractJSON(text: string): string | null {
    // Try markdown code block with optional json tag
    const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (blockMatch) return blockMatch[1].trim();

    // Try find top-level JSON object
    const jsonMatch = text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
    if (jsonMatch) return jsonMatch[0];

    return null;
  }
}
