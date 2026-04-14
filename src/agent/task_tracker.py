from typing import List, Dict, Any, Optional
from datetime import datetime
from pydantic import BaseModel, Field

class TaskError(BaseModel):
    """Record of an error encountered during task execution"""
    iteration: int = Field(description="Iteration number when error occurred")
    error_type: str = Field(description="Type of error")
    message: str = Field(description="Error message")
    timestamp: datetime = Field(default_factory=datetime.now, description="Time of error")

class TaskState(BaseModel):
    """Current state of the task execution"""
    objective: str = Field(description="Original user objective")
    iteration_count: int = Field(default=0, description="Number of execution iterations completed")
    max_iterations: int = Field(default=10, description="Maximum allowed iterations")
    errors: List[TaskError] = Field(default_factory=list, description="List of errors encountered")
    is_completed: bool = Field(default=False, description="Whether the task is completed")
    completion_reason: Optional[str] = Field(default=None, description="Reason for completion")
    final_output: Optional[str] = Field(default=None, description="Final output of the task")
    start_time: datetime = Field(default_factory=datetime.now, description="Time task started")
    end_time: Optional[datetime] = Field(default=None, description="Time task ended")

class TaskTracker:
    """Tracks task execution state and progress"""
    def __init__(self, objective: str, max_iterations: int = 10):
        self.state = TaskState(
            objective=objective,
            max_iterations=max_iterations
        )

    def increment_iteration(self) -> None:
        """Increment iteration count"""
        self.state.iteration_count += 1

    def add_error(self, error_type: str, message: str) -> None:
        """Add an error to the task history"""
        self.state.errors.append(TaskError(
            iteration=self.state.iteration_count,
            error_type=error_type,
            message=message
        ))

    def mark_completed(self, completion_reason: str, final_output: str) -> None:
        """Mark the task as completed"""
        self.state.is_completed = True
        self.state.completion_reason = completion_reason
        self.state.final_output = final_output
        self.state.end_time = datetime.now()

    def should_terminate(self) -> tuple[bool, Optional[str]]:
        """Check if task should terminate, returns (should_terminate, reason)"""
        # Check if already completed
        if self.state.is_completed:
            return True, "Task already completed"

        # Check if max iterations reached
        if self.state.iteration_count >= self.state.max_iterations:
            return True, f"Maximum iterations ({self.state.max_iterations}) reached"

        # Check for critical errors (more than 5 consecutive errors)
        recent_errors = [e for e in self.state.errors if e.iteration >= self.state.iteration_count - 5]
        if len(recent_errors) >= 5:
            return True, "Too many consecutive errors"

        return False, None

    def get_execution_summary(self) -> str:
        """Get a human-readable summary of task execution"""
        duration = (self.state.end_time or datetime.now()) - self.state.start_time
        summary = [
            f"Task Objective: {self.state.objective}",
            f"Status: {'Completed' if self.state.is_completed else 'In Progress'}",
            f"Iterations: {self.state.iteration_count}/{self.state.max_iterations}",
            f"Duration: {duration.total_seconds():.2f} seconds",
            f"Errors: {len(self.state.errors)} total"
        ]

        if self.state.is_completed:
            summary.append(f"Completion Reason: {self.state.completion_reason}")
            summary.append(f"\nFinal Output:\n{self.state.final_output}")

        if self.state.errors:
            summary.append("\nRecent Errors:")
            for err in self.state.errors[-3:]:
                summary.append(f"  Iteration {err.iteration}: {err.error_type} - {err.message}")

        return "\n".join(summary)

    def serialize(self) -> Dict[str, Any]:
        """Serialize task state to dictionary for persistence"""
        return self.state.model_dump()

    @classmethod
    def deserialize(cls, data: Dict[str, Any]) -> 'TaskTracker':
        """Deserialize task state from dictionary"""
        tracker = cls(
            objective=data["objective"],
            max_iterations=data.get("max_iterations", 10)
        )
        tracker.state = TaskState(**data)
        return tracker
