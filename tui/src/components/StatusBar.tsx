import { Box, Text } from "ink";

interface ContextStats {
  total: number;
  relevant: number;
  promptTokens: number;
}

interface StatusBarProps {
  iteration: number;
  maxIterations: number;
  errors: number;
  elapsed: number; // seconds
  visible: boolean;
  contextStats?: ContextStats | null;
}

export default function StatusBar({ iteration, maxIterations, errors, elapsed, visible, contextStats }: StatusBarProps) {
  if (!visible) return null;

  const elapsedStr =
    elapsed < 60
      ? `${elapsed.toFixed(0)}s`
      : `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toFixed(0)}s`;

  return (
    <Box paddingLeft={1} paddingRight={1} paddingTop={1} justifyContent="space-between">
      <Text dimColor>
        Iter: {iteration}/{maxIterations}
      </Text>
      <Text dimColor>
        Err: {errors}
      </Text>
      <Text dimColor>
        Ctx: {contextStats ? `${contextStats.promptTokens} tok` : "?"}
      </Text>
      <Text dimColor>
        {elapsedStr}
      </Text>
    </Box>
  );
}
