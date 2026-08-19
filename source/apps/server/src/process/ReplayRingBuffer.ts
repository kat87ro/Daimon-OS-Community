import type { ServerFrame } from "@daimon-os/shared";
import { RING_MAX_BYTES, RING_MAX_FRAMES } from "@daimon-os/shared";

/**
 * Per-channel frame history for attach/replay. Evicts oldest by frame count
 * or byte budget, whichever is exceeded first.
 */
export class ReplayRingBuffer {
  private frames: ServerFrame[] = [];
  private bytes = 0;
  lastSeq = 0;

  constructor(
    private readonly maxBytes = RING_MAX_BYTES,
    private readonly maxFrames = RING_MAX_FRAMES,
  ) {}

  push(frame: ServerFrame): void {
    if (frame.seq !== undefined) this.lastSeq = frame.seq;
    this.frames.push(frame);
    this.bytes += frameBytes(frame);
    while (
      this.frames.length > this.maxFrames ||
      (this.bytes > this.maxBytes && this.frames.length > 1)
    ) {
      const evicted = this.frames.shift();
      if (evicted) this.bytes -= frameBytes(evicted);
    }
  }

  /** All retained frames with seq > fromSeq, in order. */
  from(fromSeq: number): ServerFrame[] {
    return this.frames.filter((f) => (f.seq ?? 0) > fromSeq);
  }

  /** Oldest retained seq, or lastSeq + 1 when nothing is retained. */
  get firstSeq(): number {
    return this.frames[0]?.seq ?? this.lastSeq + 1;
  }

  get size(): number {
    return this.frames.length;
  }
}

function frameBytes(frame: ServerFrame): number {
  return typeof frame.data === "string"
    ? Buffer.byteLength(frame.data, "utf8") + 64
    : 128;
}
