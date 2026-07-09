import { ChunkBuilder } from "./chunk-builder.js";

async function main() {
  const builder = new ChunkBuilder();
  await builder.init();
  const filePath = new URL("../agent/tools.ts", import.meta.url).pathname;
  const parser = (builder as any).parsers.get("typescript");
  const { readFileSync } = await import("node:fs");
  const code = readFileSync(filePath, "utf-8");
  const tree = parser.parse(code);
  const root = tree.rootNode;
  for (const n of root.namedChildren) {
    if (n.startPosition.row === 33) {
      console.log(`Node: type="${n.type}"`);
      for (const c of n.namedChildren) {
        console.log(`  Child: type="${c.type}"  text="${c.text.slice(0, 50)}"`);
      }
    }
  }
}
main().catch(console.error);
