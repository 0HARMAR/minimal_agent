/**
 * Tree-sitter based code chunk builder for RAG.
 *
 * Parses source files using web-tree-sitter (WASM), walks the AST to find
 * semantically meaningful boundaries (functions, classes, interfaces, etc.),
 * and produces a flat list of non-overlapping CodeChunks.
 *
 * Supported languages: TypeScript, TSX, JavaScript, JSX.
 */

import { Parser, Language, Node } from "web-tree-sitter";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import type {
  CodeChunk,
  ChunkType,
  SupportedLanguage,
} from "./types.js";
import { EXTENSION_TO_LANG } from "./types.js";

// ── Default WASM paths ────────────────────────────────────────────────────

function wasmPath(pkg: string, file: string): string {
  // Try multiple strategies to find the WASM file
  const candidates: string[] = [];

  const cwd = process.cwd();

  // Strategy 1: relative to cwd's node_modules
  candidates.push(resolve(cwd, "node_modules", pkg, file));

  // Strategy 2: tui/node_modules (this project's actual layout)
  candidates.push(resolve(cwd, "tui", "node_modules", pkg, file));

  // Strategy 3: a few levels up (for monorepo / nested scenarios)
  for (let i = 0; i < 3; i++) {
    const dir = i === 0 ? cwd : resolve(cwd, ...Array(i).fill(".."));
    candidates.push(resolve(dir, "node_modules", pkg, file));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]; // fallback — let the caller report the error
}

const DEFAULT_WASM: Record<SupportedLanguage, string> = {
  javascript: wasmPath("tree-sitter-javascript", "tree-sitter-javascript.wasm"),
  jsx: wasmPath("tree-sitter-javascript", "tree-sitter-javascript.wasm"),
  typescript: wasmPath("tree-sitter-typescript", "tree-sitter-typescript.wasm"),
  tsx: wasmPath("tree-sitter-typescript", "tree-sitter-tsx.wasm"),
};

// ── ChunkBuilder ───────────────────────────────────────────────────────────

export class ChunkBuilder {
  private initialized = false;
  private parsers = new Map<SupportedLanguage, Parser>();

  /** Path overrides for WASM grammar files. */
  private wasmPaths: Partial<Record<SupportedLanguage, string>>;

  constructor(opts?: { wasmPaths?: Partial<Record<SupportedLanguage, string>> }) {
    this.wasmPaths = opts?.wasmPaths ?? {};
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Ensure the WASM runtime is loaded and all requested language parsers
   * are registered.  Safe to call multiple times.
   */
  async init(languages?: SupportedLanguage[]): Promise<void> {
    if (this.initialized) return;
    await Parser.init();
    this.initialized = true;

    const langs = languages ?? (Object.keys(DEFAULT_WASM) as SupportedLanguage[]);
    for (const lang of langs) {
      const p = this.wasmPaths[lang] ?? DEFAULT_WASM[lang];
      if (!existsSync(p)) {
        throw new Error(
          `WASM grammar not found for "${lang}" at ${p}. ` +
          `Install the grammar package (npm install tree-sitter-${lang === "tsx" ? "typescript" : lang}) ` +
          `or pass a custom wasmPaths entry.`
        );
      }
      const grammar = await Language.load(p);
      const parser = new Parser();
      parser.setLanguage(grammar);
      this.parsers.set(lang, parser);
    }
  }

  /**
   * Parse a single file and return all code chunks.
   * The extension determines which language parser to use.
   */
  async build(filePath: string, sourceCode?: string): Promise<CodeChunk[]> {
    const lang = this.detectLanguage(filePath);
    const parser = this.parsers.get(lang);
    if (!parser) {
      throw new Error(`Parser for "${lang}" not initialised. Call init() first.`);
    }

    const code = sourceCode ?? readFileSync(filePath, "utf-8");
    const tree = parser.parse(code);
    const root = tree?.rootNode;
    if (!root) return [];
    return this.extractChunks(filePath, code, root, lang);
  }

  /**
   * Parse every matching file in a directory tree.
   * Returns a Map of filePath → chunk[].  Files with unsupported extensions
   * are silently skipped.
   *
   * NOTE: This is a lightweight "lazy" collection — it only discovers file
   * paths.  Call build() on each file to get actual chunks.
   */
  collectFiles(
    dirPath: string,
    pattern?: RegExp,
  ): string[] {
    const result: string[] = [];
    const pat = pattern ?? /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
    this.walkDir(dirPath, pat, result);
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private detectLanguage(filePath: string): SupportedLanguage {
    for (const [ext, lang] of Object.entries(EXTENSION_TO_LANG)) {
      if (filePath.endsWith(ext)) return lang;
    }
    throw new Error(`Unsupported file extension: ${filePath}`);
  }

  private walkDir(dir: string, pattern: RegExp, acc: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!name.startsWith(".") && name !== "node_modules" && name !== "dist") {
          this.walkDir(full, pattern, acc);
        }
      } else if (st.isFile() && pattern.test(name)) {
        acc.push(full);
      }
    }
  }

  // ── AST walking ────────────────────────────────────────────────────────

  private extractChunks(
    filePath: string,
    code: string,
    rootNode: Node,
    lang: SupportedLanguage,
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    // Walk top-level statements
    const statements = rootNode.namedChildren;
    let i = 0;

    while (i < statements.length) {
      const node = statements[i];
      const type = node.type;

      // Group consecutive import declarations
      // (TS grammar uses "import_statement", JS grammar uses "import_declaration")
      if (type === "import_declaration" || type === "import_statement") {
        const importNodes: Node[] = [];
        while (i < statements.length &&
          (statements[i].type === "import_declaration" || statements[i].type === "import_statement")) {
          importNodes.push(statements[i]);
          i++;
        }
        chunks.push(this.makeImportBlock(filePath, importNodes, code, lang));
        continue;
      }

      // Handle export_statement: unwrap to the inner declaration
      if (type === "export_statement" || type === "export_default") {
        const inner = node.namedChildren[0] as Node | undefined;
        const innerHandler = inner ? this.getTopLevelHandler(inner.type) : null;
        if (inner && innerHandler) {
          // Create a chunk from the export_statement node but using the
          // inner declaration's type/name — this preserves the "export" keyword
          const innerChunk = innerHandler.call(this, filePath, inner, code, lang, undefined);
          if (innerChunk) {
            // Override content/signature to include the export wrapper
            innerChunk.content = node.text;
            innerChunk.startLine = node.startPosition.row;
            innerChunk.endLine = node.endPosition.row;
            // Re-sign from the outer node
            const sig = inner.type === "function_declaration" || inner.type === "class_declaration"
              ? this.nodeSignature(inner)
              : undefined;
            if (sig) innerChunk.signature = `export ${sig}`;

            chunks.push(innerChunk);

            // Extract class/interface methods from the INNER node
            if (inner.type === "class_declaration" || inner.type === "abstract_class_declaration") {
              const methods = this.extractClassMethods(filePath, inner, code, lang, innerChunk);
              chunks.push(...methods);
            }
            if (inner.type === "interface_declaration") {
              const methods = this.extractInterfaceMethods(filePath, inner, code, lang, innerChunk);
              chunks.push(...methods);
            }
          }
          i++;
          continue;
        }
        // Bare export list: `export { foo }` or `export * from '...'`
        const exportBlock = this.makeExportBlockChunk(filePath, node, code, lang);
        if (exportBlock) chunks.push(exportBlock);
        i++;
        continue;
      }

      // Handle direct top-level declarations (not wrapped in export)
      const handler = this.getTopLevelHandler(type);
      if (handler) {
        const chunk = handler.call(this, filePath, node, code, lang, undefined);
        if (chunk) {
          chunks.push(chunk);

          // Extract class/interface methods
          if (type === "class_declaration" || type === "abstract_class_declaration") {
            const methods = this.extractClassMethods(filePath, node, code, lang, chunk);
            chunks.push(...methods);
          }
          if (type === "interface_declaration") {
            const methods = this.extractInterfaceMethods(filePath, node, code, lang, chunk);
            chunks.push(...methods);
          }
        }
        i++;
        continue;
      }

      // Fallback: expression statements, etc.
      const fallback = this.makeFallbackChunk(filePath, node, code, lang);
      if (fallback) chunks.push(fallback);
      i++;
    }

    return chunks;
  }

  // ── Handler registry ──────────────────────────────────────────────────

  private getTopLevelHandler(
    type: string,
  ): ((filePath: string, node: Node, code: string, lang: SupportedLanguage, parent?: CodeChunk) => CodeChunk | null) | null {
    const handlers: Record<string, unknown> = {
      function_declaration: this.makeFunctionChunk,
      generator_function_declaration: this.makeFunctionChunk,
      class_declaration: this.makeClassChunk,
      abstract_class_declaration: this.makeClassChunk,
      interface_declaration: this.makeInterfaceChunk,
      type_alias_declaration: this.makeTypeAliasChunk,
      enum_declaration: this.makeEnumChunk,
      lexical_declaration: this.makeLexicalDeclChunk,
    };
    return (handlers[type] as typeof this.makeFunctionChunk) ?? null;
  }

  // ── Node helpers ──────────────────────────────────────────────────────

  private nodeName(node: Node): string {
    const name = node.childForFieldName("name");
    if (name) return name.text;
    // For export statements, look for the exported name
    if (node.type === "export_statement") {
      const decl = node.namedChildren.find(
        (c: Node) =>
          c.type === "function_declaration" ||
          c.type === "class_declaration" ||
          c.type === "interface_declaration" ||
          c.type === "lexical_declaration",
      );
      if (decl) return this.nodeName(decl);
    }
    // For lexical declarations, get the first variable name
    if (node.type === "lexical_declaration") {
      for (const vd of node.namedChildren) {
        if ((vd as Node).type === "variable_declarator") {
          const n = (vd as Node).childForFieldName("name");
          if (n) return n.text;
        }
      }
    }
    return node.type;
  }

  private nodeSignature(node: Node): string | undefined {
    // Only meaningful for function-like nodes
    if (
      node.type === "function_declaration" ||
      node.type === "generator_function_declaration" ||
      node.type === "method_definition"
    ) {
      // Get just the signature line(s) — from the start of the node up to
      // (but not including) the body.
      const body = node.childForFieldName("body");
      if (body) {
        return node.text.slice(0, body.startIndex - node.startIndex).trim();
      }
      return node.text.slice(0, 200).trim();
    }
    return undefined;
  }

  private makeChunkId(
    filePath: string,
    startLine: number,
    type: ChunkType,
    name: string,
  ): string {
    return `${filePath}:${startLine}:${type}:${name}`;
  }

  // ── Chunk factories ───────────────────────────────────────────────────

  private makeImportBlock(
    filePath: string,
    nodes: Node[],
    code: string,
    lang: SupportedLanguage,
  ): CodeChunk {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const startLine = first.startPosition.row;
    const endLine = last.endPosition.row;
    const content = code.slice(first.startIndex, last.endIndex);
    return {
      id: this.makeChunkId(filePath, startLine, "import_block", "imports"),
      filePath,
      startLine,
      endLine,
      type: "import_block",
      name: "imports",
      content,
      language: lang,
    };
  }

  private makeFunctionChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
    _parent?: CodeChunk,
  ): CodeChunk | null {
    const name = this.nodeName(node);
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    return {
      id: this.makeChunkId(filePath, startLine, "function_declaration", name),
      filePath,
      startLine,
      endLine,
      type: "function_declaration",
      name,
      content: node.text,
      signature: this.nodeSignature(node),
      language: lang,
    };
  }

  private makeClassChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
    _parent?: CodeChunk,
  ): CodeChunk | null {
    const name = this.nodeName(node);
    return {
      id: this.makeChunkId(filePath, node.startPosition.row, "class_declaration", name),
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: "class_declaration",
      name,
      content: node.text,
      language: lang,
    };
  }

  private makeInterfaceChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
    _parent?: CodeChunk,
  ): CodeChunk | null {
    const name = this.nodeName(node);
    return {
      id: this.makeChunkId(filePath, node.startPosition.row, "interface_declaration", name),
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: "interface_declaration",
      name,
      content: node.text,
      language: lang,
    };
  }

  private makeTypeAliasChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
    _parent?: CodeChunk,
  ): CodeChunk | null {
    const name = this.nodeName(node);
    return {
      id: this.makeChunkId(filePath, node.startPosition.row, "type_alias", name),
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: "type_alias",
      name,
      content: node.text,
      language: lang,
    };
  }

  private makeEnumChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
    _parent?: CodeChunk,
  ): CodeChunk | null {
    const name = this.nodeName(node);
    return {
      id: this.makeChunkId(filePath, node.startPosition.row, "enum_declaration", name),
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: "enum_declaration",
      name,
      content: node.text,
      language: lang,
    };
  }

  private makeLexicalDeclChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
    _parent?: CodeChunk,
  ): CodeChunk | null {
    const name = this.nodeName(node);
    // Skip anonymous/internal lexical declarations
    if (name === "lexical_declaration" || name === "") return null;
    return {
      id: this.makeChunkId(filePath, node.startPosition.row, "variable_declaration", name),
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: "variable_declaration",
      name,
      content: node.text,
      language: lang,
    };
  }

  private makeExportBlockChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
    _parent?: CodeChunk,
  ): CodeChunk | null {
    // If the export wraps a declaration (e.g. `export function foo()`),
    // delegate to the inner handler — we'll get the export via the
    // declaration's own chunk.
    const inner = node.namedChildren[0] as Node | undefined;
    if (inner && this.getTopLevelHandler(inner.type)) {
      return null; // handled by the inner declaration visitor
    }
    // Named export list: `export { foo, bar }` or `export * from '...'`
    return {
      id: this.makeChunkId(filePath, node.startPosition.row, "export_block", "export"),
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: "export_block",
      name: "export",
      content: node.text,
      language: lang,
    };
  }

  private makeFallbackChunk(
    filePath: string,
    node: Node,
    code: string,
    lang: SupportedLanguage,
  ): CodeChunk | null {
    // Skip trivial nodes
    if (node.type === "comment" || node.type === ";") return null;
    const text = node.text.trim();
    if (!text || text.length < 5) return null;
    return {
      id: this.makeChunkId(filePath, node.startPosition.row, "expression_statement", node.type),
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: "expression_statement",
      name: node.type,
      content: node.text,
      language: lang,
    };
  }

  // ── Class / Interface body walkers ────────────────────────────────────

  private extractClassMethods(
    filePath: string,
    classNode: Node,
    code: string,
    lang: SupportedLanguage,
    parent: CodeChunk,
  ): CodeChunk[] {
    const body = classNode.childForFieldName("body");
    if (!body) return [];
    const chunks: CodeChunk[] = [];
    for (const child of body.namedChildren) {
      const c = child as Node;
      if (c.type === "method_definition" || c.type === "public_field_definition") {
        const name = this.nodeName(c);
        const ct: ChunkType =
          c.type === "public_field_definition" ? "variable_declaration" : "method_declaration";
        chunks.push({
          id: this.makeChunkId(filePath, c.startPosition.row, ct, name),
          filePath,
          startLine: c.startPosition.row,
          endLine: c.endPosition.row,
          type: ct,
          name,
          content: c.text,
          signature: this.nodeSignature(c),
          parentId: parent.id,
          parentName: parent.name,
          language: lang,
        });
      }
    }
    return chunks;
  }

  private extractInterfaceMethods(
    filePath: string,
    interfaceNode: Node,
    code: string,
    lang: SupportedLanguage,
    parent: CodeChunk,
  ): CodeChunk[] {
    const body = interfaceNode.childForFieldName("body");
    if (!body) return [];
    const chunks: CodeChunk[] = [];
    for (const child of body.namedChildren) {
      const c = child as Node;
      if (
        c.type === "method_signature" ||
        c.type === "property_signature" ||
        c.type === "call_signature"
      ) {
        const name = this.nodeName(c);
        const ct: ChunkType =
          c.type === "method_signature" ? "method_declaration" : "variable_declaration";
        chunks.push({
          id: this.makeChunkId(filePath, c.startPosition.row, ct, name),
          filePath,
          startLine: c.startPosition.row,
          endLine: c.endPosition.row,
          type: ct,
          name,
          content: c.text,
          signature: c.text.length <= 200 ? c.text : undefined,
          parentId: parent.id,
          parentName: parent.name,
          language: lang,
        });
      }
    }
    return chunks;
  }
}
