import os
import subprocess
from typing import Dict, Any, Callable, List
from pydantic import BaseModel, Field, ValidationError

# ------------------------------------------------------------------------------
# Core Tool Interfaces
# ------------------------------------------------------------------------------
class ToolCall(BaseModel):
    """Structured tool call from LLM"""
    id: str = Field(default_factory=lambda: f"call_{id(object())}", description="Unique ID of the tool call")
    name: str = Field(description="Name of the tool to call")
    parameters: Dict[str, Any] = Field(description="Parameters for the tool")

class ToolResult(BaseModel):
    """Standardized tool execution result"""
    success: bool = Field(description="Whether the tool executed successfully")
    content: str = Field(description="Output content or error message")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

class BaseTool:
    """Abstract base class for all tools"""
    name: str
    description: str
    parameters: Dict[str, Any]

    def __init__(self, project_root: str):
        self.project_root = os.path.abspath(project_root)
        # Ensure project root exists
        if not os.path.exists(self.project_root):
            raise ValueError(f"Project root {self.project_root} does not exist")

    def run(self, parameters: Dict[str, Any]) -> ToolResult:
        """Execute the tool with given parameters"""
        raise NotImplementedError("Subclasses must implement run()")

    def to_schema(self) -> Dict[str, Any]:
        """Return tool schema for LLM function calling"""
        # Extract required list and remove 'required' from property definitions
        required = [k for k, v in self.parameters.items() if v.get("required")]
        properties = {k: {kk: vv for kk, vv in v.items() if kk != "required"}
                      for k, v in self.parameters.items()}

        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required
                }
            }
        }

# ------------------------------------------------------------------------------
# Core Tool Implementations
# ------------------------------------------------------------------------------
class ReadFileTool(BaseTool):
    name = "read_file"
    description = "Read the contents of a file from the project directory"
    parameters = {
        "file_path": {
            "type": "string",
            "description": "Relative path to the file from project root",
            "required": True
        }
    }

    def _validate_path(self, file_path: str) -> str:
        """Validate path is within project root and resolve absolute path"""
        abs_path = os.path.abspath(os.path.join(self.project_root, file_path))
        root = os.path.join(self.project_root, "")  # ensure trailing separator
        if not abs_path.startswith(root):
            raise PermissionError(f"Path traversal detected: {file_path} is outside project root")
        return abs_path

    def run(self, parameters: Dict[str, Any]) -> ToolResult:
        try:
            file_path = parameters["file_path"]
            abs_path = self._validate_path(file_path)

            if not os.path.exists(abs_path):
                return ToolResult(success=False, content=f"File not found: {file_path}")
            if not os.path.isfile(abs_path):
                return ToolResult(success=False, content=f"Path is not a file: {file_path}")

            file_size = os.path.getsize(abs_path)
            if file_size > 10 * 1024 * 1024:  # 10 MB limit
                return ToolResult(success=False, content=f"File too large: {file_path} ({file_size} bytes, max 10MB)")

            with open(abs_path, "r", encoding="utf-8") as f:
                content = f.read()

            return ToolResult(
                success=True,
                content=content,
                metadata={"file_path": file_path, "size": len(content)}
            )
        except Exception as e:
            return ToolResult(success=False, content=f"Error reading file: {str(e)}")

class WriteFileTool(BaseTool):
    name = "write_file"
    description = "Write content to a file in the project directory (overwrites existing files)"
    parameters = {
        "file_path": {
            "type": "string",
            "description": "Relative path to the file from project root",
            "required": True
        },
        "content": {
            "type": "string",
            "description": "Content to write to the file",
            "required": True
        }
    }

    def _validate_path(self, file_path: str) -> str:
        """Validate path is within project root and resolve absolute path"""
        abs_path = os.path.abspath(os.path.join(self.project_root, file_path))
        root = os.path.join(self.project_root, "")  # ensure trailing separator
        if not abs_path.startswith(root):
            raise PermissionError(f"Path traversal detected: {file_path} is outside project root")
        return abs_path

    def run(self, parameters: Dict[str, Any]) -> ToolResult:
        try:
            file_path = parameters["file_path"]
            content = parameters["content"]
            abs_path = self._validate_path(file_path)

            # Create parent directories if they don't exist
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)

            with open(abs_path, "w", encoding="utf-8") as f:
                f.write(content)

            return ToolResult(
                success=True,
                content=f"Successfully wrote {len(content)} characters to {file_path}",
                metadata={"file_path": file_path, "size": len(content)}
            )
        except Exception as e:
            return ToolResult(success=False, content=f"Error writing file: {str(e)}")

class RunShellTool(BaseTool):
    name = "run_shell"
    description = (
        "Run a shell command in the project directory. "
        "Allowed commands: ls, cat, grep, find, git, python, python3, npm, node, "
        "pwd, echo, head, tail, wc, sort, uniq, cut, tr, sed, awk, xargs, diff, "
        "mkdir, cp, mv, touch, dirname, basename, which, tee, printf, env. "
        "Pipes (|) and output redirection (>, >>) are allowed. "
        "Operators ;, &, $, and backticks are blocked."
    )
    parameters = {
        "command": {
            "type": "string",
            "description": "Shell command to execute (see tool description for allowed commands and operators)",
            "required": True
        }
    }

    ALLOWED_COMMANDS = {
        "ls", "cat", "grep", "find", "git", "python", "python3", "npm", "node",
        "pwd", "echo", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "sed",
        "awk", "xargs", "diff", "mkdir", "cp", "mv", "touch", "dirname", "basename",
        "which", "tee", "printf", "env",
    }

    # Dangerous commands — blocked as the base command (first word).
    BLOCKED_COMMANDS = {"rm", "sudo", "su", "chmod", "chown", "wget", "curl", "ssh", "scp", "eval"}

    # Shell metacharacters blocked only when they appear unquoted.
    # Mapped to: (multi_char_variant, still_dangerous_in_double_quotes)
    SHELL_META = {
        ";":  (None, False),
        "&":  (None, False),
        "$":  (None, True),
        "`":  (None, True),
    }

    def _scan_unquoted(self, command: str) -> str | None:
        """Walk the command tracking shell quote state.

        Returns the first dangerous metacharacter found outside an
        appropriate quoting context, or None if the command is clean.
        """
        in_single = False
        in_double = False
        i = 0
        while i < len(command):
            ch = command[i]

            if ch == "'" and not in_double:
                in_single = not in_single
                i += 1
                continue
            if ch == '"' and not in_single:
                in_double = not in_double
                i += 1
                continue

            if ch == '\\' and not in_single:
                i += 2  # skip escaped char
                continue

            # Double-quoted: only $ and ` remain dangerous
            if in_double and ch in ('$', '`'):
                return ch

            if not in_single and not in_double:
                meta = self.SHELL_META.get(ch)
                if meta:
                    multi, _ = meta
                    if multi and command.startswith(multi, i):
                        return multi
                    return ch

            i += 1
        return None

    def _validate_command(self, command: str) -> None:
        """Validate command is safe to execute"""
        cmd_parts = command.strip().split()
        if not cmd_parts:
            raise ValueError("Empty command")

        base_cmd = cmd_parts[0]
        if base_cmd not in self.ALLOWED_COMMANDS:
            raise PermissionError(
                f"Command '{base_cmd}' is not allowed. "
                f"Allowed commands: {', '.join(sorted(self.ALLOWED_COMMANDS))}"
            )
        if base_cmd in self.BLOCKED_COMMANDS:
            raise PermissionError(f"Command '{base_cmd}' is blocked")

        offender = self._scan_unquoted(command)
        if offender:
            raise PermissionError(f"Command contains blocked shell operator: {offender}")

    def run(self, parameters: Dict[str, Any]) -> ToolResult:
        try:
            command = parameters["command"]
            self._validate_command(command)

            result = subprocess.run(
                command,
                shell=True,
                cwd=self.project_root,
                capture_output=True,
                text=True,
                timeout=30  # 30 second timeout
            )

            if result.returncode == 0:
                output = result.stdout
                success = True
            else:
                output = f"Command failed with exit code {result.returncode}\nStderr: {result.stderr}"
                success = False

            return ToolResult(
                success=success,
                content=output,
                metadata={"command": command, "returncode": result.returncode}
            )
        except Exception as e:
            return ToolResult(success=False, content=f"Error running command: {str(e)}")

# ------------------------------------------------------------------------------
# Tool Registry
# ------------------------------------------------------------------------------
class ToolRegistry:
    """Registry for managing and executing tools"""
    def __init__(self, project_root: str):
        self.project_root = project_root
        self.tools: Dict[str, BaseTool] = {}
        # Register core tools
        self.register_tool(ReadFileTool(project_root))
        self.register_tool(WriteFileTool(project_root))
        self.register_tool(RunShellTool(project_root))

    def register_tool(self, tool: BaseTool) -> None:
        """Register a new tool"""
        self.tools[tool.name] = tool

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Get all tool schemas for LLM function calling"""
        return [tool.to_schema() for tool in self.tools.values()]

    def execute_tool_call(self, tool_call: ToolCall) -> ToolResult:
        """Execute a tool call"""
        if tool_call.name not in self.tools:
            return ToolResult(
                success=False,
                content=f"Tool {tool_call.name} not found. Available tools: {', '.join(self.tools.keys())}"
            )

        tool = self.tools[tool_call.name]
        return tool.run(tool_call.parameters)
