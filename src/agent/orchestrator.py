from typing import Optional
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
        provider: str = None
    ):
        # Load defaults from environment if not provided
        self.max_iterations = max_iterations or int(os.getenv("MAX_ITERATIONS", "10"))
        self.model_name = model_name or os.getenv("MODEL_NAME")
        self.provider = provider or os.getenv("LLM_PROVIDER", "deepseek")

        # Initialize components
        self.context = ContextManager()
        self.tool_registry = ToolRegistry(project_root)
        self.llm_gateway = LLMGateway(api_key=api_key, model=self.model_name, provider=self.provider)
        self.task_tracker = TaskTracker(objective, max_iterations=self.max_iterations)

        # Set up system prompt
        self.context.set_system_prompt(LLMGateway.format_system_prompt())

        # Add initial user objective to context
        self.context.add_message(role="user", content=f"Your task: {objective}")

    def run(self) -> str:
        """Run the main execution loop until termination"""
        print(f"Starting agent execution for task: {self.task_tracker.state.objective}")
        print(f"Max iterations: {self.max_iterations}\n")

        while True:
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
            print(f"\n=== Iteration {self.task_tracker.state.iteration_count}/{self.max_iterations} ===")

            # Get messages for LLM
            messages = self.context.get_prompt_messages()
            tool_schemas = self.tool_registry.get_tool_schemas()

            # Call LLM
            print("Calling LLM...")
            tool_calls, final_response = self.llm_gateway.generate_response(messages, tool_schemas)

            # DEBUG: Print raw AI response
            print(f"\n=== RAW AI RESPONSE ===")
            print(f"Tool calls: {tool_calls}")
            print(f"Final response: {final_response}")
            print(f"=======================\n")

            # Handle LLM error
            if final_response and (final_response.startswith("Error:") or "error" in final_response.lower()):
                print(f"LLM Error: {final_response}")
                self.task_tracker.add_error("LLMError", final_response)
                self.context.add_message(role="assistant", content=final_response)
                continue

            # Handle final response
            if final_response is not None:
                print(f"Received final response: {final_response[:200]}...")
                self.context.add_message(role="assistant", content=final_response)

                # Check for completion signal
                if "TASK_COMPLETE" in final_response or self.task_tracker.state.iteration_count >= self.max_iterations -1:
                    clean_output = final_response.replace("TASK_COMPLETE", "").strip()
                    self.task_tracker.mark_completed(
                        completion_reason="Task completed successfully",
                        final_output=clean_output
                    )
                    break
                continue

            # Handle tool calls
            if tool_calls:
                print(f"Received {len(tool_calls)} tool call(s)")

                # Format tool_calls for the API
                formatted_tool_calls = []
                for i, tool_call in enumerate(tool_calls):
                    print(f"  [{i+1}] Tool: {tool_call.name}, Params: {list(tool_call.parameters.keys())}")
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
                    print(f"    → {status}: {result.content[:100]}...")

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
        print(f"\n=== Task Completed ===")
        summary = self.task_tracker.get_execution_summary()
        print(summary)
        return summary

    def get_state(self) -> dict:
        """Get the current state of all components for debugging"""
        return {
            "task": self.task_tracker.serialize(),
            "context": self.context.serialize()
        }
