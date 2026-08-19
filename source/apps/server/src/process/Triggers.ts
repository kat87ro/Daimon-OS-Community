import fs from "node:fs";
import type { Schedule } from "@daimon-os/shared";
import type { ConfigStore } from "../config/ConfigStore";

/** Parse one cron field against a value, supporting star, N, step (star-slash-N),
 *  ranges A-B, and comma-lists of any of those. Returns true when value matches. */
function matchField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (step <= 0) continue;
      let lo: number;
      let hi: number;
      if (range === "*") {
        lo = 0;
        hi = Number.POSITIVE_INFINITY;
      } else if (range!.includes("-")) {
        const [a, b] = range!.split("-").map(Number);
        lo = a!;
        hi = b!;
      } else {
        lo = Number(range);
        hi = Number.POSITIVE_INFINITY;
      }
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (value >= a! && value <= b!) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}

/** Evaluate a 5-field cron expression (minute hour dom month dow) against a
 *  Date. dow: 0–6, Sunday = 0. Malformed expressions never match. */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;
  const day = date.getDay(); // 0–6, Sunday = 0
  return (
    matchField(min!, date.getMinutes()) &&
    matchField(hour!, date.getHours()) &&
    matchField(dom!, date.getDate()) &&
    matchField(mon!, date.getMonth() + 1) &&
    // standard cron treats both 0 and 7 as Sunday — accept either
    (matchField(dow!, day) || (day === 0 && matchField(dow!, 7)))
  );
}

const CRON_TICK_MS = 60_000;
const WATCH_DEBOUNCE_MS = 1_000;

/**
 * Arms enabled schedules and fires their blueprints onto their projects.
 *  - interval → a per-schedule setInterval(spec ms)
 *  - cron     → one shared 60s ticker evaluating every cron schedule's 5-field
 *               expression against the current minute
 *  - watch    → fs.watch(spec) with a ~1s debounce
 * All timers are unref()'d so they never keep the process alive. reload()
 * re-arms after any schedule CRUD.
 */
export class Triggers {
  private intervalTimers = new Map<string, NodeJS.Timeout>();
  private watchers = new Map<string, fs.FSWatcher>();
  private watchDebounce = new Map<string, NodeJS.Timeout>();
  private cronTicker: NodeJS.Timeout | null = null;
  private cronIds: string[] = [];
  private started = false;

  constructor(
    private readonly store: ConfigStore,
    private readonly onFire: (schedule: Schedule) => void,
  ) {}

  start(): void {
    this.started = true;
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.disarm();
  }

  /** re-read schedules and re-arm; call after any schedule CRUD */
  reload(): void {
    if (!this.started) return;
    this.disarm();
    this.arm();
  }

  private fire(schedule: Schedule): void {
    try {
      this.onFire(schedule);
    } catch {
      // a single bad blueprint/project must not tear down the ticker
    }
  }

  private arm(): void {
    const enabled = this.store.listSchedules().filter((s) => s.enabled);
    this.cronIds = [];
    for (const s of enabled) {
      if (s.kind === "interval") {
        const ms = Number(s.spec);
        if (!Number.isFinite(ms) || ms <= 0) continue;
        const t = setInterval(() => this.fire(s), ms);
        t.unref();
        this.intervalTimers.set(s.id, t);
      } else if (s.kind === "cron") {
        this.cronIds.push(s.id);
      } else if (s.kind === "watch") {
        try {
          const w = fs.watch(s.spec, () => {
            const prev = this.watchDebounce.get(s.id);
            if (prev) clearTimeout(prev);
            const d = setTimeout(() => {
              this.watchDebounce.delete(s.id);
              this.fire(s);
            }, WATCH_DEBOUNCE_MS);
            d.unref();
            this.watchDebounce.set(s.id, d);
          });
          this.watchers.set(s.id, w);
        } catch {
          // unwatchable path (missing/permissions) — skip, don't crash arming
        }
      }
    }
    if (this.cronIds.length && !this.cronTicker) {
      this.cronTicker = setInterval(() => this.tickCron(), CRON_TICK_MS);
      this.cronTicker.unref();
    }
  }

  private tickCron(): void {
    const now = new Date();
    for (const id of this.cronIds) {
      const s = this.store.getSchedule(id as Schedule["id"]);
      if (!s || !s.enabled || s.kind !== "cron") continue;
      if (cronMatches(s.spec, now)) this.fire(s);
    }
  }

  private disarm(): void {
    for (const t of this.intervalTimers.values()) clearInterval(t);
    this.intervalTimers.clear();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const d of this.watchDebounce.values()) clearTimeout(d);
    this.watchDebounce.clear();
    if (this.cronTicker) {
      clearInterval(this.cronTicker);
      this.cronTicker = null;
    }
    this.cronIds = [];
  }
}
