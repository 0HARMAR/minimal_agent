from typing import Optional, Callable
import os
import json
from dotenv import load_dotenv

from .context import ContextManager
from .tools import ToolRegistry, ToolCall
from .llm_gateway import LLMGateway
from .task_tracker import TaskTracker

# Load environment variables
load_dotenv()

class Orchestrator:
    """Main orchestrator that manages the agent execution loop"""
    def __init__(
        self,
        project_root: str,
        objective: str,
        max_iterations: int = None,
        model_name: str = None,
        api_key: str = None,
        provider: str = None,
        stream_callback: Optional[Callable[[str], None]] = None,
        stop_check: Optional[Callable[[], bool]] = None,
    ):
        # Load defaults from environment if not provided
        self.max_iterations = max_iterations or int(os.getenv("MAX_ITERATIONS", "10"))
        self.model_name = model_name or os.getenv("MODEL_NAME")
        self.provider = provider or os.getenv("LLM_PROVIDER", "deepseek")
        self.stream_callback = stream_callback
        self.stop_check = stop_check

        # Initialize components
        self.context = ContextManager()
        self.tool_registry = ToolRegistry(project_root)
        self.llm_gateway = LLMGateway(api_key=api_key, model=self.model_name, provider=self.provider)
        self.task_tracker = TaskTracker(objective, max_iterations=self.max_iterations)

        # Set up system prompt
        self.context.set_system_prompt(LLMGateway.format_system_prompt())

        # Add initial user objective to context
        self.context.add_message(role="user", content=f"Your task: {objective}")

    def _emit(self, msg: str) -> None:
        """Emit output to the stream callback, falling back to print."""
        if self.stream_callback:
            self.stream_callback(msg)
        else:
            print(msg)

    def run(self) -> str:
        """Run the main execution loop until termination"""
        self._emit(f"Starting agent execution for task: {self.task_tracker.state.objective}")
        self._emit(f"Max iterations: {self.max_iterations}")
        self._emit("")

        while True:
            # Check if stop was requested externally
            if self.stop_check and self.stop_check():
                self.task_tracker.mark_completed(
                    completion_reason="Stopped by user",
                    final_output="Task stopped by user request."
                )
                self._emit("\n[bold yellow]Stop requested — terminating.[/bold yellow]")
                break

            # Check if we should terminate
            should_terminate, reason = self.task_tracker.should_terminate()
            if should_terminate:
                self.task_tracker.mark_completed(
                    completion_reason=reason,
                    final_output=f"Task terminated: {reason}"
                )
                break

            # Increment iteration counter
            self.task_tracker.increment_iteration()
            self._emit(f"\n=== Iteration {self.task_tracker.state.iteration_count}/{self.max_iterations} ===")

            # Get messages for LLM
            messages = self.context.get_prompt_messages()
            tool_schemas = self.tool_registry.get_tool_schemas()

            # Call LLM
            self._emit("Calling LLM...")
            tool_calls, final_response = self.llm_gateway.generate_response(messages, tool_schemas)

            # Handle LLM error
            if final_response and final_response.startswith("Error:"):
                self._emit(f"LLM Error: {final_response}")
                self.task_tracker.add_error("LLMError", final_response)
                self.context.add_message(role="assistant", content=final_response)
                continue

            # Handle final response
            if final_response is not None:
                self._emit(f"Received final response: {final_response[:200]}...")
                self.context.add_message(role="assistant", content=final_response)

                # Check for completion signal
                if "TASK_COMPLETE" in final_response or self.task_tracker.state.iteration_count >= self.max_iterations - 1:
                    clean_output = final_response.replace("TASK_COMPLETE", "").strip()
                    self.task_tracker.mark_completed(
                        completion_reason="Task completed successfully",
                        final_output=clean_output
                    )
                    break
                continue

            # Handle tool calls
            if tool_calls:
                self._emit(f"Received {len(tool_calls)} tool call(s)")

                # Format tool_calls for the API
                formatted_tool_calls = []
                for i, tool_call in enumerate(tool_calls):
                    self._emit(f"  [{i+1}] Tool: {tool_call.name}, Params: {list(tool_call.parameters.keys())}")
                    formatted_tool_calls.append({
                        "id": tool_call.id,
                        "type": "function",
                        "function": {
                            "name": tool_call.name,
                            "arguments": json.dumps(tool_call.parameters)
                        }
                    })

                # Add assistant message with tool_calls FIRST
                self.context.add_message(role="assistant", content="", tool_calls=formatted_tool_calls)

                # Then execute tools and add results
                for tool_call in tool_calls:
                    # Execute tool
                    result = self.tool_registry.execute_tool_call(tool_call)
                    status = "SUCCESS" if result.success else "FAILED"
                    self._emit(f"    → {status}: {result.content[:100]}...")

                    # Add result to context
                    self.context.add_tool_result(
                        tool_name=tool_call.name,
                        success=result.success,
                        content=result.content,
                        tool_call_id=tool_call.id,
                        metadata=result.metadata
                    )

                    # Track errors
                    if not result.success:
                        self.task_tracker.add_error(f"ToolError:{tool_call.name}", result.content[:200])

        # Return final summary
        self._emit(f"\n=== Task Completed ===")
        summary = self.task_tracker.get_execution_summary()
        self._emit(summary)
        return summary

    def get_state(self) -> dict:
        """Get the current state of all components for debugging"""
        return {
            "task": self.task_tracker.serialize(),
            "context": self.context.serialize()
        }
