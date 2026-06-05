import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  running: boolean;
}

export default function InputBox({ value, onChange, onSubmit, running }: InputBoxProps) {
  const promptColor = running ? "#f9e2af" : "#a6e3a1";
  const prompt = running ? "⟳" : ">";

  return (
    <Box paddingLeft={1} paddingRight={1} paddingTop={1}>
      <Text color={promptColor} bold>
        {prompt}
      </Text>
      <Text> </Text>
      {running ? (
        <Text dimColor>Agent running... type a /command or Ctrl+C</Text>
      ) : (
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      )}
    </Box>
  );
}
