import { Box, Text } from "ink";

interface StatusBarProps {
  iteration: number;
  maxIterations: number;
  errors: number;
  elapsed: number; // seconds
  visible: boolean;
}

export default function StatusBar({ iteration, maxIterations, errors, elapsed, visible }: StatusBarProps) {
  if (!visible) return null;

  const elapsedStr =
    elapsed < 60
      ? `${elapsed.toFixed(0)}s`
      : `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toFixed(0)}s`;

  return (
    <Box paddingLeft={1} paddingRight={1} paddingTop={1} justifyContent="space-between">
      <Text dimColor>
        Iteration: {iteration}/{maxIterations}
      </Text>
      <Text dimColor>
        Errors: {errors}
      </Text>
      <Text dimColor>
        Elapsed: {elapsedStr}
      </Text>
    </Box>
  );
}
