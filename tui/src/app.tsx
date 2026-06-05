import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Orchestrator } from "./agent/orchestrator.js";
import MessageLog from "./components/MessageLog.js";
import InputBox from "./components/InputBox.js";
import StatusBar from "./components/StatusBar.js";

const LOGO_LINES = [
  "███╗   ███╗██╗███╗   ██╗██╗",
  "████╗ ████║██║████╗  ██║██║",
  "██╔████╔██║██║██╔██╗ ██║██║",
  "██║╚██╔╝██║██║██║╚██╗██║██║",
  "██║ ╚═╝ ██║██║██║ ╚████║██║",
  "╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝",
  "",
  "  ░█████╗░░█████╗░██████╗░███████╗",
  "  ██╔══██╗██╔══██╗██╔══██╗██╔════╝",
  "  ██║░░╚═╝██║░░██║██║░░██║█████╗░░",
  "  ██║░░██╗██║░░██║██║░░██║██╔══╝░░",
  "  ╚█████╔╝╚█████╔╝██████╔╝███████╗",
  "   ╚════╝░░╚════╝░╚═════╝░╚══════╝.",
];

const HELP_TEXT = [
  "Type any task description to run the agent.",
  "",
  "Commands:",
  "  /help   — show this message",
  "  /clear  — clear message history",
  "  /stop   — stop a running agent",
  "  /quit   — exit",
  "",
  "Press Ctrl+C or Ctrl+D to exit at any time.",
];

export default function App() {
  const { exit } = useApp();

  const [messages, setMessages] = useState<ReactNode[]>([
    ...LOGO_LINES.map((line) => (
      <Text key={line} color="cyan" bold>{line}</Text>
    )),
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Status bar state
  const [iteration, setIteration] = useState(0);
  const [maxIterations, setMaxIterations] = useState(10);
  const [errorCount, setErrorCount] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const stopRef = useRef(false);
  const elapsedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingBashRef = useRef<{ resolve: (v: boolean) => void } | null>(null);
  const [pendingBashCmd, setPendingBashCmd] = useState<string | null>(null);

  // Elapsed timer
  useEffect(() => {
    if (running && startTime !== null) {
      elapsedTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [running, startTime]);

  const addMessage = useCallback((msg: ReactNode) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const addMessages = useCallback((msgs: ReactNode[]) => {
    setMessages((prev) => [...prev, ...msgs]);
  }, []);

  const onConfirmBash = useCallback(
    (command: string): Promise<boolean> => {
      return new Promise((resolve) => {
        pendingBashRef.current = { resolve };
        setPendingBashCmd(command);
        addMessage(
          <Box flexDirection="row">
            <Text backgroundColor="#f9e2af" color="#1e1e2e" bold> BASH </Text>
            <Text> </Text>
            <Text dimColor>{command}</Text>
            <Text>  </Text>
            <Text backgroundColor="#a6e3a1" color="#1e1e2e"> Y </Text>
            <Text>/</Text>
            <Text backgroundColor="#f38ba8" color="#1e1e2e"> N </Text>
          </Box>,
        );
      });
    },
    [addMessage],
  );

  const runAgent = useCallback(
    async (objective: string) => {
      setRunning(true);
      setHasError(false);
      setIteration(0);
      setErrorCount(0);
      setStartTime(Date.now());
      setElapsed(0);
      stopRef.current = false;

      const projectRoot = process.cwd();

      const orch = new Orchestrator({
        projectRoot,
        objective,
        maxIterations: parseInt(process.env["MAX_ITERATIONS"] ?? "10", 10),
        modelName: process.env["MODEL_NAME"],
        apiKey: process.env["DEEPSEEK_API_KEY"],
        onLog: (msg: string) => {
          addMessage(msg);
          // Try to extract iteration info from messages
          const iterMatch = msg.match(/=== Iteration (\d+)\/(\d+) ===/);
          if (iterMatch) {
            setIteration(parseInt(iterMatch[1], 10));
            setMaxIterations(parseInt(iterMatch[2], 10));
          }
          const errMatch = msg.match(/Error/);
          if (errMatch) {
            setErrorCount((prev) => prev + 1);
          }
        },
        stopCheck: () => stopRef.current,
        onConfirmBash,
      });

      try {
        await orch.run();
      } catch (e: any) {
        addMessage(`Unexpected error: ${e.message}`);
        setHasError(true);
      } finally {
        setRunning(false);
      }
    },
    [addMessage],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      addMessage(`You: ${trimmed}`);

      if (trimmed.startsWith("/")) {
        const [cmd] = trimmed.slice(1).split(/\s+/);

        switch (cmd) {
          case "help":
            addMessages(HELP_TEXT);
            break;
          case "clear":
            setMessages([
              ...LOGO_LINES.map((line) => (
                <Text key={line} color="cyan" bold>{line}</Text>
              )),
            ]);
            break;
          case "stop":
            if (running) {
              stopRef.current = true;
              addMessage("Stop requested — will take effect at next iteration.");
            } else {
              addMessage("No agent is running.");
            }
            break;
          case "quit":
            stopRef.current = true;
            addMessage("Goodbye!");
            exit();
            return;
          default:
            addMessage(`Unknown command: /${cmd}. Use /help.`);
        }
      } else {
        if (running) {
          addMessage("Agent is already running. Use /stop to interrupt first.");
        } else {
          runAgent(trimmed);
        }
      }

      setInput("");
    },
    [running, runAgent, addMessage, addMessages, exit],
  );

  // Global keyboard shortcuts (Ctrl+Z to stop)
  useInput((input, key) => {
    if (pendingBashRef.current) {
      const lower = input.toLowerCase();
      if (lower === "y" || lower === "yes") {
        const resolve = pendingBashRef.current.resolve;
        pendingBashRef.current = null;
        setPendingBashCmd(null);
        resolve(true);
        addMessage(
          <Text>
            <Text color="#a6e3a1" bold>  ALLOWED</Text>
          </Text>,
        );
        return;
      }
      if (lower === "n" || lower === "no" || key.escape) {
        const resolve = pendingBashRef.current.resolve;
        pendingBashRef.current = null;
        setPendingBashCmd(null);
        resolve(false);
        addMessage(
          <Text>
            <Text color="#f38ba8" bold>  DENIED</Text>
          </Text>,
        );
        return;
      }
      return;
    }
    if (key.ctrl && (input === "c" || input === "d")) {
      stopRef.current = true;
      exit();
    }
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <MessageLog messages={messages} />
      <StatusBar
        iteration={iteration}
        maxIterations={maxIterations}
        errors={errorCount}
        elapsed={elapsed}
        visible={running || startTime !== null}
      />
      <InputBox
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        running={running}
      />
    </Box>
  );
}
