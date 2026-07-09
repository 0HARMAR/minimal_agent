/**
 * LRU cache with TTL, staleness checks, and stats tracking.
 *
 * Used by tools to avoid redundant disk reads, shell commands, and queries.
 */
import { statSync } from "node:fs";

export interface CacheEntry<T> {
  value: T;
  /** When this entry was created (epoch ms). */
  createdAt: number;
  /** When this entry expires (epoch ms). 0 = no expiry. */
  expiresAt: number;
  /** For file caches: mtime of the source file when cached. */
  sourceMtime?: number;
  /** Optional label for stats (e.g., file path). */
  label?: string;
}

export interface CacheStats {
  label: string;
  entries: number;
  hits: number;
  misses: number;
  /** Estimated bytes saved by returning cached results. */
  bytesSaved: number;
  /** Calls that avoided disk/network by using cache. */
  cacheAvoided: number;
}

export interface CacheOpts {
  /** Max entries. LRU eviction kicks in above this. Default 200. */
  maxSize?: number;
  /** Default TTL in ms. Default 60_000 (1 min). 0 = no expiry. */
  defaultTtlMs?: number;
  /** Label for stats display. */
  label?: string;
}

interface LRUItem {
  key: string;
  /** Monotonically increasing access counter. */
  accessOrder: number;
}

export class ToolCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private lruList: LRUItem[] = [];
  private accessCounter = 0;

  readonly maxSize: number;
  readonly defaultTtlMs: number;
  readonly label: string;

  // Stats
  hits = 0;
  misses = 0;
  bytesSaved = 0;
  cacheAvoided = 0;

  constructor(opts: CacheOpts = {}) {
    this.maxSize = opts.maxSize ?? 200;
    this.defaultTtlMs = opts.defaultTtlMs ?? 60_000;
    this.label = opts.label ?? "cache";
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Get a cached value. Returns undefined on miss or expiry. */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }

    // Check file mtime staleness (for file-backed entries)
    if (entry.sourceMtime !== undefined && entry.label) {
      try {
        const currentMtime = statSync(entry.label).mtimeMs;
        if (currentMtime > entry.sourceMtime) {
          // File changed since cached
          this.store.delete(key);
          this.misses++;
          return undefined;
        }
      } catch {
        // File disappeared; treat as stale
        this.store.delete(key);
        this.misses++;
        return undefined;
      }
    }

    // Hit — update LRU order
    this.hits++;
    this.touch(key);
    return entry.value;
  }

  /** Store a value. */
  set<T>(key: string, value: T, ttlMs?: number, meta?: { sourceMtime?: number; label?: string; byteSize?: number }): void {
    const now = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;

    this.store.set(key, {
      value,
      createdAt: now,
      expiresAt: ttl > 0 ? now + ttl : 0,
      sourceMtime: meta?.sourceMtime,
      label: meta?.label,
    } as CacheEntry<unknown>);

    if (meta?.byteSize) {
      this.bytesSaved += meta.byteSize;
    }
    this.cacheAvoided++;

    // Track LRU
    this.touch(key);
    this.evictIfNeeded();
  }

  /** Check if a key exists and is fresh (without counting as a hit). */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /** Invalidate a specific key. */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate all keys matching a prefix (e.g., all entries under a directory). */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** Clear all entries and reset stats. */
  clear(): void {
    this.store.clear();
    this.lruList = [];
    this.accessCounter = 0;
    this.hits = 0;
    this.misses = 0;
    this.bytesSaved = 0;
    this.cacheAvoided = 0;
  }

  /** Get snapshot of stats. */
  getStats(): CacheStats {
    return {
      label: this.label,
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      bytesSaved: this.bytesSaved,
      cacheAvoided: this.cacheAvoided,
    };
  }

  /** Hit rate as percentage string. */
  hitRate(): string {
    const total = this.hits + this.misses;
    if (total === 0) return "—";
    return ((this.hits / total) * 100).toFixed(1) + "%";
  }

  // ── Private ─────────────────────────────────────────────────────────

  private touch(key: string): void {
    this.accessCounter++;
    // Find existing LRU entry and update its order
    for (const item of this.lruList) {
      if (item.key === key) {
        item.accessOrder = this.accessCounter;
        return;
      }
    }
    // New entry
    this.lruList.push({ key, accessOrder: this.accessCounter });
  }

  private evictIfNeeded(): void {
    if (this.store.size <= this.maxSize) return;

    // Sort by access order ascending, remove oldest
    this.lruList.sort((a, b) => a.accessOrder - b.accessOrder);
    while (this.store.size > this.maxSize && this.lruList.length > 0) {
      const oldest = this.lruList.shift()!;
      this.store.delete(oldest.key);
    }
  }
}

/** Determine if a shell command is read-only (safe to cache). */
export function isReadonlyCommand(command: string): boolean {
  const trimmed = command.trim();
  // Read-only command patterns
  const readonlyPatterns = [
    /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/,
    /^grep\b/, /^find\b/, /^wc\b/, /^sort\b/, /^uniq\b/,
    /^echo\b/, /^which\b/, /^type\b/, /^file\b/, /^stat\b/,
    /^du\b/, /^df\b/, /^date\b/, /^whoami\b/, /^pwd\b/,
    /^git\s+(log|diff|show|status|branch|tag|rev-parse|describe)\b/,
    /^npm\s+(list|view|search|pack\s+--dry-run)\b/,
    /^pip\s+(list|show|search)\b/,
    /^python\s+-c\b.*print/, // Python one-liners that just print
    /^npx\s+tsc\s+--noEmit\b/, /^npx\s+tsx\b.*--help/,
  ];
  for (const pattern of readonlyPatterns) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}
