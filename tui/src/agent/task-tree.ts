/**
 * Task tree — hierarchical task structure for smart context management.
 *
 * Tracks user tasks and agent subtasks as a tree, enabling priority-based
 * context trimming: always keep active tasks, compress completed ones.
 */

export type TaskNodeType = "root" | "subtask" | "side";

export interface TaskNode {
  id: string;
  type: TaskNodeType;
  goal: string;
  status: "active" | "completed";
  children: TaskNode[];
  parentId: string | null;
  /** Range of message indices [start, end) owned by this node. */
  msgRange: [number, number];
  createdAt: number;
  completedAt: number | null;
  /** For subtasks: which plan step index (0-based). */
  planStepIndex: number | null;
  /** Whether this node has been compressed (messages replaced by summary). */
  compressed: boolean;
}

export interface CompressedInfo {
  nodeId: string;
  goal: string;
  type: TaskNodeType;
  msgRange: [number, number];
}

let _nextId = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++_nextId}`;
}

export interface TaskTreeOpts {
  /** Max messages before compression kicks in. 0 = unlimited. */
  maxMessages?: number;
}

export class TaskTree {
  readonly nodes = new Map<string, TaskNode>();
  readonly rootNodes: TaskNode[] = [];
  activeNodeId: string | null = null;
  private maxMessages: number;
  private msgCount = 0;

  constructor(opts: TaskTreeOpts = {}) {
    this.maxMessages = opts.maxMessages ?? 0;
  }

  // ── Factory methods ─────────────────────────────────────────────────

  /** Create a new root task (user message / objective). */
  createRootTask(goal: string, side = false): TaskNode {
    const node: TaskNode = {
      id: nextId(side ? "side" : "task"),
      type: side ? "side" : "root",
      goal,
      status: "active",
      children: [],
      parentId: null,
      msgRange: [this.msgCount, this.msgCount],
      createdAt: Date.now(),
      completedAt: null,
      planStepIndex: null,
      compressed: false,
    };
    this.nodes.set(node.id, node);
    this.rootNodes.push(node);
    this.activeNodeId = node.id;
    return node;
  }

  /** Create a subtask under a parent node (from planner step). */
  createSubtask(parentId: string, goal: string, planStepIndex?: number): TaskNode {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new Error(`Parent node ${parentId} not found`);

    const node: TaskNode = {
      id: nextId("subtask"),
      type: "subtask",
      goal,
      status: "active",
      children: [],
      parentId,
      msgRange: [this.msgCount, this.msgCount],
      createdAt: Date.now(),
      completedAt: null,
      planStepIndex: planStepIndex ?? null,
      compressed: false,
    };
    this.nodes.set(node.id, node);
    parent.children.push(node);
    this.activeNodeId = node.id;
    return node;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Mark a node (and all its children) as completed. */
  completeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.completeRecursive(node);
  }

  private completeRecursive(node: TaskNode): void {
    node.status = "completed";
    node.completedAt = Date.now();
    for (const child of node.children) {
      this.completeRecursive(child);
    }
  }

  /** Advance the message counter (called when messages are added). */
  recordMessages(count: number): void {
    this.msgCount += count;
  }

  /** Extend the active node's message range to include new messages. */
  extendActiveRange(toIndex: number): void {
    if (!this.activeNodeId) return;
    const node = this.nodes.get(this.activeNodeId);
    if (node) {
      node.msgRange[1] = Math.max(node.msgRange[1], toIndex);
    }
  }

  /**
   * Compress completed nodes that are past the sliding window.
   * Returns info about what was compressed so the caller can build summaries.
   */
  compressCompletedNodes(keepLastComplete = 1): CompressedInfo[] {
    const compressed: CompressedInfo[] = [];
    const completedRoots = this.rootNodes
      .filter((n) => n.status === "completed" && !n.compressed)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

    // Keep the most recent N completed roots, compress the rest
    for (let i = keepLastComplete; i < completedRoots.length; i++) {
      this.collectCompressed(completedRoots[i], compressed);
    }
    return compressed;
  }

  private collectCompressed(node: TaskNode, acc: CompressedInfo[]): void {
    if (node.compressed) return;
    for (const child of node.children) {
      this.collectCompressed(child, acc);
    }
    acc.push({
      nodeId: node.id,
      goal: node.goal,
      type: node.type,
      msgRange: node.msgRange,
    });
    node.msgRange = [0, 0];
    node.compressed = true;
  }

  // ── Query ───────────────────────────────────────────────────────────

  /** Get the active path: root → ... → current active node. */
  getActivePath(): TaskNode[] {
    const path: TaskNode[] = [];
    let current = this.activeNodeId ? this.nodes.get(this.activeNodeId) : null;
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.nodes.get(current.parentId) ?? null : null;
    }
    return path;
  }

  /** Get all nodes whose message ranges are still visible (not compressed). */
  getVisibleNodes(): TaskNode[] {
    const visible: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.msgRange[0] < node.msgRange[1]) {
        visible.push(node);
      }
    }
    return visible;
  }

  /** Get the set of message indices that should be retained. */
  getRetainedIndices(): Set<number> {
    const retained = new Set<number>();

    // Always keep the active path (root → active subtask)
    const activePath = this.getActivePath();
    for (const node of activePath) {
      for (let i = node.msgRange[0]; i < node.msgRange[1]; i++) {
        retained.add(i);
      }
    }

    // Keep visible (non-compressed) completed nodes
    for (const node of this.getVisibleNodes()) {
      if (!activePath.includes(node)) {
        for (let i = node.msgRange[0]; i < node.msgRange[1]; i++) {
          retained.add(i);
        }
      }
    }

    return retained;
  }

  /** Serialize for inspection / debugging. */
  serialize(): Record<string, unknown> {
    return {
      rootCount: this.rootNodes.length,
      totalNodes: this.nodes.size,
      activeNodeId: this.activeNodeId,
      activePath: this.getActivePath().map((n) => n.id),
      roots: this.rootNodes.map((n) => this.serializeNode(n)),
    };
  }

  private serializeNode(node: TaskNode): Record<string, unknown> {
    return {
      id: node.id,
      type: node.type,
      goal: node.goal.slice(0, 80),
      status: node.status,
      msgRange: node.msgRange,
      children: node.children.map((c) => this.serializeNode(c)),
    };
  }
}
