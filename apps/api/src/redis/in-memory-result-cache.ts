import { Injectable } from "@nestjs/common";
import { Clock } from "../common/clock";
import { AppConfig } from "../config/app-config";
import { ResultCache } from "../simulation/result-cache";

/** Most text kept, counted in characters, before the least recently used entries go. */
const MAX_CHARACTERS = 32 * 1024 * 1024;

/**
 * The cache in a Map, for one process. Bounded like a Redis set to `allkeys-lru`: when it holds
 * too much, the least recently used entries are dropped. A Map remembers insertion order, so
 * moving an entry to the end on every hit makes the first entry the least recently used.
 */
@Injectable()
export class InMemoryResultCache extends ResultCache {
  private readonly entries = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  private characters = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.remove(key);
    if (entry.expiresAt <= this.clock.now().getTime()) return undefined;
    this.entries.set(key, entry); // now the most recently used
    this.characters += entry.value.length;
    return entry.value;
  }

  async set(key: string, value: string): Promise<boolean> {
    if (this.config.cacheTtlSeconds === 0 || value.length > MAX_CHARACTERS) return false;
    this.remove(key);
    this.entries.set(key, { value, expiresAt: this.clock.now().getTime() + this.config.cacheTtlSeconds * 1000 });
    this.characters += value.length;
    for (const [oldest] of this.entries) {
      if (this.characters <= MAX_CHARACTERS) break;
      this.remove(oldest);
    }
    return true;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.characters -= entry.value.length;
  }
}
