# Minimal Agent
A minimal, educational implementation of an autonomous coding agent similar to Claude Code. This project distills the core architectural patterns of production-grade agents into a simple, analyzable codebase perfect for learning.

## Architecture Overview
This agent implements the exact architecture described in `minimal_agent.md`, with 5 core components:

| Component | File | Responsibility |
|-----------|------|----------------|
| **Orchestrator** | `src/agent/orchestrator.py` | Main control loop, manages execution flow and termination |
| **LLM Gateway** | `src/agent/llm_gateway.py` | Handles API communication, prompt formatting, tool call parsing |
| **Tool Registry & Executor** | `src/agent/tools.py` | Manages available tools, executes operations with safety constraints |
| **Context Manager** | `src/agent/context.py` | Stores conversation history, implements rolling window truncation |
| **Task State Tracker** | `src/agent/task_tracker.py` | Monitors task progress, iteration count, errors, and completion status |

## Features
✅ **File I/O**: Read and write files with path sandboxing to prevent directory traversal
✅ **Shell Execution**: Run whitelisted commands with safety validation
✅ **Context Management**: Rolling window to prevent context overflow
✅ **Error Handling**: Automatic error recovery and iteration limits
✅ **Safety Constraints**: Command whitelisting, path sandboxing, execution timeouts
✅ **Deterministic Loop**: Clear, predictable execution flow

## Installation
1. Clone or download this repository
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Copy the environment example file:
   ```bash
   cp .env.example .env
   ```
4. Edit `.env` and fill in:
   - `DEEPSEEK_API_KEY`: Your DeepSeek API key
   - `PROJECT_ROOT`: Path to the directory where the agent will operate (e.g., `/tmp/agent_test`)
   - Optional: Adjust `MAX_ITERATIONS` and `MODEL_NAME`

## Usage
### Quick Start
Run the example script:
```bash
python example.py
```

The example will create a `hello.py` script and run it to verify functionality.

### Custom Usage
```python
from src.agent import Orchestrator

# Initialize agent
agent = Orchestrator(
    project_root="/path/to/your/project",
    objective="Write a Python function to calculate Fibonacci numbers and save it to fib.py",
    max_iterations=10
)

# Run the agent
result = agent.run()
print(result)
```

## Core Tools
The agent comes with 3 built-in tools:
1. **read_file(file_path)**: Read the contents of a file from the project directory
2. **write_file(file_path, content)**: Write content to a file (overwrites existing)
3. **run_shell(command)**: Run a whitelisted shell command in the project directory

### Safety Features
- **Path Sandboxing**: All file operations are restricted to the configured `PROJECT_ROOT`
- **Command Whitelisting**: Only pre-approved commands are allowed (ls, cat, grep, find, git, python, npm, etc.)
- **Blocked Keywords**: Dangerous operations (rm, sudo, shell redirection, pipes) are blocked
- **Execution Timeout**: Shell commands time out after 30 seconds
- **Iteration Limit**: Prevents infinite loops with configurable max iterations

## Learning Objectives
This codebase is designed to teach:
1. How ReAct (Reasoning + Action) agent loops work
2. How function calling / tool use is implemented in practice
3. How to handle context window management and truncation
4. How to implement safety constraints for agentic systems
5. How to structure agent components with clear separation of concerns

## Extension Ideas
Once you understand the core implementation, try extending it:
1. Add more tools (e.g., `git_commit`, `run_tests`, `search_code`)
2. Add parallel tool execution support
3. Implement context summarization for longer tasks
4. Add a planning module that breaks tasks into steps before execution
5. Add unit test validation to automatically verify task completion
6. Add a simple web UI or CLI interface
7. Support other LLM providers (OpenAI, Gemini, Anthropic, etc.)

## Project Structure
```
minimal_agent/
├── src/
│   └── agent/
│       ├── __init__.py
│       ├── orchestrator.py    # Main control loop
│       ├── llm_gateway.py     # LLM API interface
│       ├── tools.py           # Tool registry and implementations
│       ├── context.py         # Context management
│       └── task_tracker.py    # Task state monitoring
├── example.py                 # Example usage
├── requirements.txt           # Dependencies
├── .env.example               # Environment configuration template
├── minimal_agent.md           # Original architectural design document
└── README.md                  # This file
```

## License
MIT - Feel free to use this for learning and experimentation!
