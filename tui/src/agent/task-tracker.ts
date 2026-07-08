export interface TaskError {
  iteration: number;
  errorType: string;
  message: string;
  timestamp: Date;
}

export interface TaskState {
  objective: string;
  iterationCount: number;
  maxIterations: number;
  errors: TaskError[];
  isCompleted: boolean;
  completionReason: string | null;
  finalOutput: string | null;
  startTime: Date;
  endTime: Date | null;
  currentStep: number;
  totalSteps: number;
}

export class TaskTracker {
  state: TaskState;

  constructor(objective: string, maxIterations = 10) {
    this.state = {
      objective,
      maxIterations,
      iterationCount: 0,
      errors: [],
      isCompleted: false,
      completionReason: null,
      finalOutput: null,
      startTime: new Date(),
      endTime: null,
      currentStep: 0,
      totalSteps: 0,
    };
  }

  incrementIteration(): void {
    this.state.iterationCount++;
  }

  setSteps(total: number): void {
    this.state.totalSteps = total;
    this.state.currentStep = total > 0 ? 1 : 0;
  }

  advanceStep(): void {
    if (this.state.currentStep < this.state.totalSteps) {
      this.state.currentStep++;
    }
  }

  addError(errorType: string, message: string): void {
    this.state.errors.push({
      iteration: this.state.iterationCount,
      errorType,
      message,
      timestamp: new Date(),
    });
  }

  markCompleted(completionReason: string, finalOutput: string): void {
    this.state.isCompleted = true;
    this.state.completionReason = completionReason;
    this.state.finalOutput = finalOutput;
    this.state.endTime = new Date();
  }

  shouldTerminate(): { terminate: boolean; reason?: string } {
    if (this.state.isCompleted) {
      return { terminate: true, reason: "Task already completed" };
    }
    if (this.state.iterationCount >= this.state.maxIterations) {
      return { terminate: true, reason: `Maximum iterations (${this.state.maxIterations}) reached` };
    }
    const recentErrors = this.state.errors.filter(
      (e) => e.iteration >= this.state.iterationCount - 5,
    );
    if (recentErrors.length >= 5) {
      return { terminate: true, reason: "Too many consecutive errors" };
    }
    return { terminate: false };
  }

  getExecutionSummary(): string {
    const end = this.state.endTime ?? new Date();
    const duration = (end.getTime() - this.state.startTime.getTime()) / 1000;
    const lines = [
      `Task Objective: ${this.state.objective}`,
      `Status: ${this.state.isCompleted ? "Completed" : "In Progress"}`,
      `Iterations: ${this.state.iterationCount}/${this.state.maxIterations}`,
      `Duration: ${duration.toFixed(2)} seconds`,
      `Errors: ${this.state.errors.length} total`,
      `Steps: ${this.state.currentStep}/${this.state.totalSteps}`,
    ];

    if (this.state.isCompleted) {
      lines.push(`Completion Reason: ${this.state.completionReason}`);
      lines.push(`\nFinal Output:\n${this.state.finalOutput}`);
    }

    if (this.state.errors.length > 0) {
      lines.push("\nRecent Errors:");
      for (const err of this.state.errors.slice(-3)) {
        lines.push(`  Iteration ${err.iteration}: ${err.errorType} - ${err.message}`);
      }
    }

    return lines.join("\n");
  }

  serialize(): Record<string, unknown> {
    return { ...this.state, startTime: this.state.startTime.toISOString(), endTime: this.state.endTime?.toISOString() ?? null };
  }
}
