import type { ReactNode } from "react";
import { Box, Text } from "ink";

interface MarkdownTextProps {
  children: string;
}

const CO = "#f5c2e7";
const CI = "#a6e3a1";
const CH = "#89b4fa";

function renderInline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <Text>
      {parts.map((p, i) => {
        if (p.startsWith("`") && p.endsWith("`")) {
          return (
            <Text key={i} color={CI}>
              {p.slice(1, -1)}
            </Text>
          );
        }
        if (p.startsWith("**") && p.endsWith("**")) {
          return (
            <Text key={i} bold>
              {p.slice(2, -2)}
            </Text>
          );
        }
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

export default function MarkdownText({ children }: MarkdownTextProps) {
  const nodes: ReactNode[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(children)) !== null) {
    if (match.index > lastIndex) {
      const before = children.slice(lastIndex, match.index);
      nodes.push(...renderParagraphs(before));
    }

    const code = match[0]
      .replace(/^```\w*\n?/, "")
      .replace(/\n?```$/, "")
      .replace(/[\u001b][[()#;?]*\d*(?:;\d+)*[A-Za-z]?/g, "");

    nodes.push(
      <Box
        key={nodes.length}
        flexDirection="column"
        borderStyle="round"
        borderColor="#585b70"
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
        marginBottom={1}
      >
        {code.split("\n").map((line, i) => (
          <Text key={i} color={CO}>
            {line}
          </Text>
        ))}
      </Box>,
    );

    lastIndex = codeBlockRegex.lastIndex;
  }

  if (lastIndex < children.length) {
    const after = children.slice(lastIndex);
    nodes.push(...renderParagraphs(after));
  }

  if (nodes.length === 0) {
    nodes.push(renderInline(children));
  }

  return (
    <Box flexDirection="column">
      {nodes.map((n, i) => (
        <Box key={i} flexDirection="column">
          {n}
        </Box>
      ))}
    </Box>
  );
}

function renderParagraphs(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const paragraphs = text.split(/\n{2,}/);

  for (const para of paragraphs) {
    if (!para.trim()) continue;

    const lines = para.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        nodes.push(<Box key={nodes.length} height={1} />);
        continue;
      }

      if (/^###\s/.test(trimmed)) {
        nodes.push(
          <Box key={nodes.length} marginTop={1}>
            <Text bold color={CH}>
              {trimmed.replace(/^###\s+/, "")}
            </Text>
          </Box>,
        );
      } else if (/^##\s/.test(trimmed)) {
        nodes.push(
          <Box key={nodes.length} marginTop={1}>
            <Text bold color={CH}>
              {trimmed.replace(/^##\s+/, "")}
            </Text>
          </Box>,
        );
      } else if (/^#\s/.test(trimmed)) {
        nodes.push(
          <Box key={nodes.length} marginTop={1}>
            <Text bold color={CH}>
              {trimmed.replace(/^#\s+/, "")}
            </Text>
          </Box>,
        );
      } else if (/^-\s/.test(trimmed)) {
        nodes.push(
          <Box key={nodes.length}>
            <Text color="#6c7086">  • </Text>
            {renderInline(trimmed.replace(/^-\s+/, ""))}
          </Box>,
        );
      } else if (/^\d+\.\s/.test(trimmed)) {
        const num = trimmed.match(/^(\d+)\./)?.[1] ?? "?";
        nodes.push(
          <Box key={nodes.length}>
            <Text color="#6c7086">{num}. </Text>
            {renderInline(trimmed.replace(/^\d+\.\s+/, ""))}
          </Box>,
        );
      } else {
        nodes.push(
          <Box key={nodes.length}>{renderInline(line)}</Box>,
        );
      }
    }
  }

  return nodes;
}
