# Minimal Agentic Code Assistant: Architectural Design Document

## 1. Overview
This document specifies the architectural design of a minimal autonomous coding agent. The system replicates the core functional capabilities of production-grade tools such as Claude Code, including iterative file manipulation, shell command execution, context-aware reasoning, and self-correcting task execution. The design intentionally omits non-essential subsystems (e.g., vector memory, parallel execution, UI layers, multi-agent routing) to expose the foundational control flow and component interactions that define modern LLM-driven agents. The primary objective is pedagogical: to provide a clear, analyzable blueprint for studying agent architecture.

## 2. Foundational Architectural Principles
The design adheres to the following principles to ensure minimalism, transparency, and educational clarity:
- **Deterministic Control Loop:** A single, synchronous observation-reasoning-action cycle governs execution.
- **Explicit State Boundary:** All mutable state is explicitly tracked and serializable; no implicit or hidden memory.
- **Tool-Use as First-Class Primitive:** All external interactions are mediated through a standardized tool invocation schema.
- **Constraint-First Safety:** Execution boundaries are enforced at the tool layer, not retroactively.
- **Separation of Concerns:** Reasoning, execution, and state management are strictly isolated to facilitate analysis and extension.

## 3. System Components
The architecture comprises five discrete modules. Each module exposes a well-defined interface and maintains internal state boundaries.

| Component | Responsibility | Architectural Role |
|-----------|----------------|-------------------|
| **Orchestrator** | Manages the execution loop, enforces termination conditions, and routes control flow between modules. | State machine / Control plane |
| **LLM Gateway** | Formats prompts, injects tool schemas, parses structured LLM responses (tool calls vs. final output), and handles API communication. | Interface layer / Protocol adapter |
| **Tool Registry & Executor** | Maintains an immutable registry of available tools (`read_file`, `write_file`, `run_shell`). Validates inputs, executes operations, captures outputs/errors, and returns standardized results. | Execution layer / I/O mediator |
| **Context Manager** | Stores conversation history, tool invocation logs, and execution metadata. Implements windowing, truncation, and optional summarization strategies. | Memory subsystem / Context optimizer |
| **Task State Tracker** | Records the original objective, iteration count, error history, success/failure flags, and completion criteria. | Audit trail / Progress monitor |

## 4. Execution Control Flow
The agent operates via a deterministic loop that continues until a terminal condition is met. The sequence is as follows:

1. **Initialization:** Load project directory constraints, configure tool registry, initialize context and task state.
2. **Prompt Assembly:** The Context Manager and Task State Tracker supply historical state. The LLM Gateway constructs a structured prompt containing: system instructions, available tool schemas, conversation history, and the current task objective.
3. **LLM Invocation:** The prompt is submitted to the language model. The response is parsed into one of two branches:
   - **Terminal Response:** Contains a final answer or explicit completion signal.
   - **Tool Invocation(s):** Contains structured calls to one or more registered tools with validated arguments.
4. **Tool Execution:** The Tool Registry routes each call to its executor. Output (stdout, stderr, file diffs, status codes) is captured and normalized.
5. **State Update:** Execution results are appended to the Context Manager. The Task State Tracker updates iteration counters and error logs.
6. **Termination Evaluation:** The Orchestrator checks against predefined conditions:
   - Maximum iteration threshold reached
   - Critical execution error (e.g., permission violation, unrecoverable tool failure)
   - Explicit LLM completion signal
   - Task success validation (optional heuristic)
7. **Output Generation:** Final state, execution transcript, and resulting artifacts are returned.

## 5. State and Context Management
Context management is critical to agent stability. The design employs a constrained, rolling-state model:
- **Fixed-Size History Window:** Maintains the most recent N message-tool pairs. Older entries are discarded or summarized to prevent context window overflow.
- **Structured Tool Logging:** Every tool call and its result are stored as discrete, parseable records. This enables precise error tracing and supports iterative correction.
- **State Serialization:** All mutable state (history, task metadata, iteration counters) is periodically serialized to disk. This supports resumability and debugging without introducing complex persistence layers.
- **No External Memory:** The system intentionally excludes embedding-based retrieval or long-term vector stores to maintain architectural transparency.

## 6. Safety and Constraint Model
Safety is enforced at the execution boundary, prior to tool invocation:
- **Path Sandboxing:** File operations are restricted to a predefined project root. Path traversal sequences (`../`, absolute paths outside root) are rejected.
- **Command Whitelisting:** Shell execution permits only pre-approved command categories (e.g., `ls`, `cat`, `grep`, `git`, `python`, `npm`). Dangerous primitives (`rm -rf`, `sudo`, network utilities) are blocked.
- **Input Validation:** All tool arguments are schema-validated before execution. Type mismatches or missing required fields trigger immediate rejection.
- **Iteration Cap:** A hard limit on loop cycles prevents infinite recursion or resource exhaustion.
- **Deterministic Failover:** On tool error, the Orchestrator injects the error output into context and continues the loop, allowing the LLM to attempt correction. Unrecoverable errors trigger graceful termination.

## 7. Educational Mapping and Extension Pathways
This architecture isolates core agent design patterns, making it suitable for systematic study:

| Concept Demonstrated | Location in Architecture | Extension Pathway |
|----------------------|--------------------------|-------------------|
| ReAct Paradigm | Orchestrator loop + Tool Registry | Add explicit planning/reflection steps |
| Function Calling / Tool Use | LLM Gateway schema + Tool Executor | Introduce parallel execution, dynamic tool discovery |
| Context Window Management | Context Manager | Implement summarization, retrieval-augmented memory, hierarchical state |
| Error Recovery & Iteration | Task State Tracker + Loop termination | Add retry policies, self-verification, test-driven validation |
| Safety Sandboxing | Tool Registry validation layer | Integrate OS-level containers, capability-based access control |

Students may incrementally augment the design by replacing synchronous execution with async concurrency, introducing a planner module for multi-step decomposition, or integrating external verification pipelines (e.g., unit test execution, linting).

## 8. Inherent Limitations and Trade-offs
Minimalism necessitates deliberate compromises:
- **Sequential Execution:** Tools are executed synchronously, preventing parallel file I/O or concurrent shell processes.
- **Native Reasoning Dependency:** The agent relies entirely on the base LLM's reasoning capabilities; no explicit planning, verification, or self-reflection modules are included.
- **Static Tool Set:** Tools are hardcoded at initialization. Dynamic tool discovery or user-defined tool registration is omitted.
- **Heuristic Termination:** Success detection relies on LLM signaling or iteration limits rather than automated validation (e.g., test suite execution).
- **Context Truncation Loss:** Rolling windows may discard critical historical context, potentially degrading performance on long-horizon tasks.

These limitations are intentional. They isolate the fundamental agentic loop while clearly delineating where production systems introduce additional complexity.

## 9. Conclusion
This design document presents a minimal, analyzable architecture for an autonomous coding agent. By distilling the system to its essential components—a deterministic control loop, explicit tool mediation, constrained context management, and boundary-enforced safety—the architecture exposes the foundational mechanics that underpin more sophisticated agents such as Claude Code. The design serves as a pedagogical baseline: each component maps directly to established AI engineering patterns, and each omission highlights a specific axis along which production systems evolve. Implementation should proceed component-by-component, with rigorous validation of state transitions, tool schemas, and termination conditions to ensure architectural integrity.