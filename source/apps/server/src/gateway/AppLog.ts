import type { AppLogEntry } from "@daimon-os/shared";

const MAX_ENTRIES = 2000;

/**
 * App-wide operational log — spawns, exits, task transitions, errors. In-memory
 * ring (telemetry, not persisted); the gateway subscribes to push new entries
 * live on the reserved gateway channel.
 */
export class AppLog {
  private entries: AppLogEntry[] = [];
  private listeners = new Set<(e: AppLogEntry) => void>();

  emit(
    level: AppLogEntry["level"],
    source: string,
    message: string,
    channel?: string,
    detail?: string,
  ): void {
    const entry: AppLogEntry = { ts: Date.now(), level, source, message, channel, detail };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    for (const fn of this.listeners) fn(entry);
  }

  recent(limit = 500): AppLogEntry[] {
    return this.entries.slice(-limit);
  }

  subscribe(fn: (e: AppLogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
