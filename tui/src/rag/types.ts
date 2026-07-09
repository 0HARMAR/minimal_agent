/**
 * RAG types for the code chunk builder.
 *
 * A "chunk" is a semantically meaningful unit of code (function, class,
 * interface, type alias, import block, etc.) extracted via tree-sitter AST.
 */

/** The category of a code chunk — determines how it's indexed and used in RAG. */
export type ChunkType =
  | "file"               // entire file as one chunk
  | "import_block"       // a group of consecutive import statements
  | "function_declaration"
  | "method_declaration"
  | "class_declaration"
  | "interface_declaration"
  | "type_alias"
  | "enum_declaration"
  | "export_block"       // export { ... }
  | "variable_declaration" // top-level const/let/var (e.g. export const X = ...)
  | "module_export"      // module.exports = ...  or exports.X = ...
  | "expression_statement"; // unclassified top-level statement

/** A single code chunk extracted from a source file. */
export interface CodeChunk {
  /** Globally unique identifier (filePath:startLine-type-name). */
  id: string;
  /** Absolute or project-relative path to the source file. */
  filePath: string;
  /** 0-based start line in the source file. */
  startLine: number;
  /** 0-based end line (inclusive) in the source file. */
  endLine: number;
  /** Semantic type of this chunk. */
  type: ChunkType;
  /** Human-readable name (function name, class name, etc.). */
  name: string;
  /** The raw source text of this chunk. */
  content: string;
  /** Optional short signature for display (e.g. `createUser(name: string): User`). */
  signature?: string;
  /** For class-children: the parent chunk id this belongs to. */
  parentId?: string;
  /** For methods: the class/interface they belong to. */
  parentName?: string;
  /** File extension hint (e.g. ".ts", ".tsx", ".js"). */
  language: string;
}

/** Supported programming languages for chunking. */
export type SupportedLanguage = "typescript" | "tsx" | "javascript" | "jsx";

/** Map a file extension to a tree-sitter language identifier. */
export const EXTENSION_TO_LANG: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
};

export const CHUNK_WEIGHTS: Record<ChunkType, number> = {
  file: 0,
  import_block: 1,
  function_declaration: 5,
  method_declaration: 4,
  class_declaration: 5,
  interface_declaration: 4,
  type_alias: 3,
  enum_declaration: 3,
  export_block: 2,
  variable_declaration: 3,
  module_export: 2,
  expression_statement: 1,
};
