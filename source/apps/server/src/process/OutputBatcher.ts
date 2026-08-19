import { FLUSH_INTERVAL_MS, FLUSH_MAX_BYTES } from "@daimon-os/shared";

/**
 * Coalesces high-frequency PTY output into one frame per flush window —
 * flushes on a 16 ms timer or an 8 KB budget, whichever hits first.
 */
export class OutputBatcher {
  private buf = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onFlush: (data: string) => void,
    private readonly intervalMs = FLUSH_INTERVAL_MS,
    private readonly maxBytes = FLUSH_MAX_BYTES,
  ) {}

  accept(data: string): void {
    this.buf += data;
    if (this.buf.length >= this.maxBytes) {
      this.flushNow();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flushNow(), this.intervalMs);
    }
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buf.length === 0) return;
    const out = this.buf;
    this.buf = "";
    this.onFlush(out);
  }

  dispose(): void {
    this.flushNow();
  }
}
