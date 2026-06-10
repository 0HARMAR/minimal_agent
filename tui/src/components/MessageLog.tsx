import type { ReactNode } from "react";
import { Box, Text } from "ink";
import MarkdownText from "./MarkdownText.js";

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
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" paddingLeft={1}>
          {typeof msg === "string" ? <MarkdownText>{msg}</MarkdownText> : msg}
        </Box>
      ))}
    </Box>
  );
}
