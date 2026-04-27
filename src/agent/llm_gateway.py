import os
import json
from typing import List, Dict, Any, Optional, Tuple
from .tools import ToolCall, ToolResult

# Try to import openai, install if needed
try:
    from openai import OpenAI, APIError as OpenAIAPIError
except ImportError:
    import subprocess
    subprocess.run(["pip", "install", "openai"], check=True)
    from openai import OpenAI, APIError as OpenAIAPIError


# Provider configurations
PROVIDER_CONFIGS = {
    "openai": {
        "api_key_env": "OPENAI_API_KEY",
        "default_model": "gpt-4o",
        "base_url": "https://api.openai.com/v1",
    },
    "deepseek": {
        "api_key_env": "DEEPSEEK_API_KEY",
        "default_model": "deepseek-chat",
        "base_url": "https://api.deepseek.com/v1",
    },
    "qwen": {
        "api_key_env": "DASHSCOPE_API_KEY",
        "default_model": "qwen-turbo",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    "kimi": {
        "api_key_env": "KIMI_API_KEY",
        "default_model": "moonshot-v1-8k-chat",
        "base_url": "https://api.moonshot.cn/v1",
    },
    "anthropic": {
        "api_key_env": "ANTHROPIC_API_KEY",
        "default_model": "claude-3-haiku-20240307",
        "base_url": None,  # Uses native SDK
    },
    "azure": {
        "api_key_env": "AZURE_OPENAI_API_KEY",
        "default_model": "gpt-4",
        "base_url": None,  # Set via AZURE_OPENAI_ENDPOINT
    },
}


class LLMGateway:
    """Gateway for communicating with various LLM APIs (OpenAI-compatible)"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        provider: str = "deepseek",
        temperature: float = 0.0,
        max_tokens: int = 4096,
        base_url: Optional[str] = None,
    ):
        """
        Initialize the LLM gateway.

        Args:
            api_key: API key (reads from env if not provided)
            model: Model name (defaults based on provider)
            provider: Provider name (deepseek, qwen, kimi, openai, etc.)
            temperature: Sampling temperature
            max_tokens: Max tokens in response
            base_url: Custom base URL (optional, overrides provider default)
        """
        self.provider = provider.lower()

        # Get provider config or use custom
        if self.provider in PROVIDER_CONFIGS:
            config = PROVIDER_CONFIGS[self.provider]
            self.api_key = api_key or os.getenv(config["api_key_env"])
            self.model = model or config["default_model"]
            self.base_url = base_url or config["base_url"]
        else:
            # Custom provider
            self.api_key = api_key or os.getenv("OPENAI_API_KEY")
            self.model = model or "gpt-4o"
            self.base_url = base_url

        if not self.api_key:
            raise ValueError(f"API key not provided. Set {self.provider.upper()}_API_KEY or pass api_key.")

        # Initialize client
        if self.provider == "anthropic":
            # Use native Anthropic SDK
            from anthropic import Anthropic, APIError, APIConnectionError, AuthenticationError
            self.client = Anthropic(api_key=self.api_key)
            self._use_native = True
        else:
            # Use OpenAI-compatible client
            self.client = OpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
            )
            self._use_native = False

        self.temperature = temperature
        self.max_tokens = max_tokens

    def _convert_tools_openai(self, tool_schemas: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert tool schemas to OpenAI format"""
        return tool_schemas

    def generate_response(
        self,
        messages: List[Dict[str, str]],
        tool_schemas: List[Dict[str, Any]]
    ) -> Tuple[Optional[List[ToolCall]], Optional[str]]:
        """
        Generate a response from the LLM.
        Returns either (list of tool calls, None) or (None, final response text)
        """
        if self._use_native:
            return self._generate_anthropic(messages, tool_schemas)
        else:
            return self._generate_openai(messages, tool_schemas)

    def _generate_openai(
        self,
        messages: List[Dict[str, str]],
        tool_schemas: List[Dict[str, Any]]
    ) -> Tuple[Optional[List[ToolCall]], Optional[str]]:
        """Generate response using OpenAI-compatible API"""
        try:
            # Prepare tools if provided
            tools = self._convert_tools_openai(tool_schemas) if tool_schemas else None

            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
            )

            # DEBUG: Print raw API response
            print(f"\n[DEBUG LLMGateway] Raw API response: {response}")
            print(f"[DEBUG LLMGateway] Response content: {response.choices[0].message}")

            message = response.choices[0].message

            # Check for tool calls
            if message.tool_calls:
                tool_calls = []
                for tc in message.tool_calls:
                    try:
                        params = json.loads(tc.function.arguments)
                    except json.JSONDecodeError as e:
                        return None, f"Error: Invalid JSON in tool call arguments: {str(e)}"
                    tool_calls.append(ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        parameters=params
                    ))
                return tool_calls, None

            # Text response
            return None, message.content.strip() if message.content else ""

        except OpenAIAPIError as e:
            return None, f"API Error: {str(e)}"
        except Exception as e:
            return None, f"Unexpected error: {str(e)}"

    def _generate_anthropic(
        self,
        messages: List[Dict[str, str]],
        tool_schemas: List[Dict[str, Any]]
    ) -> Tuple[Optional[List[ToolCall]], Optional[str]]:
        """Generate response using Anthropic API"""
        try:
            from anthropic import AuthenticationError, APIConnectionError, APIError

            response = self.client.beta.tools.messages.create( # type: ignore
                model=self.model,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                messages=messages,
                tools=tool_schemas
            )

            # DEBUG: Print raw API response
            print(f"\n[DEBUG LLMGateway] Raw Anthropic response: {response}")
            print(f"[DEBUG LLMGateway] Stop reason: {response.stop_reason}")
            print(f"[DEBUG LLMGateway] Content: {response.content}")

            if response.stop_reason == "tool_use":
                tool_calls = []
                for content in response.content:
                    if content.type == "tool_use":
                        tool_calls.append(ToolCall(
                            id=content.id,
                            name=content.name,
                            parameters=content.input
                        ))
                return tool_calls, None
            else:
                text_response = "\n".join([
                    c.text for c in response.content
                    if c.type == "text"
                ])
                return None, text_response.strip()

        except AuthenticationError:
            return None, "Error: Invalid API key"
        except APIConnectionError:
            return None, "Error: Could not connect to API"
        except APIError as e:
            return None, f"API Error: {str(e)}"
        except Exception as e:
            return None, f"Unexpected error: {str(e)}"

    @staticmethod
    def format_system_prompt(base_prompt: Optional[str] = None) -> str:
        """Format the base system prompt for the coding agent"""
        default_prompt = """
You are a minimal autonomous coding agent. Your purpose is to help users with programming tasks by reading and writing files and executing shell commands.

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
        """.strip()

        return base_prompt or default_prompt
