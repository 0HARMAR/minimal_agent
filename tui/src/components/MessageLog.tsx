import type { ReactNode } from "react";
import { Box, Static, Text } from "ink";

interface MessageLogProps {
  messages: ReactNode[];
}

export default function MessageLog({ messages }: MessageLogProps) {
  if (messages.length === 0) {
    return (
      <Box paddingLeft={1} paddingTop={1} flexGrow={1}>
        <Text dimColor>(no messages yet)</Text>
      </Box>
    );
  }

  return (
    <Box flexGrow={1} flexDirection="column">
      <Static items={messages}>
        {(msg, i) => (
          <Box key={i} paddingLeft={1}>
            {typeof msg === "string" ? <Text>{msg}</Text> : msg}
          </Box>
        )}
      </Static>
    </Box>
  );
}
