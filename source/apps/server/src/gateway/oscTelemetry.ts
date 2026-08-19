import type { TelemetryEvent } from "@daimon-os/shared";
import { TELEMETRY_OSC_CODE, telemetryEventSchema } from "@daimon-os/shared";

const OSC_START = `\x1b]${TELEMETRY_OSC_CODE};`;
const BEL = "\x07";
const MAX_CARRY = 64 * 1024;

/**
 * Argus — streaming extractor for in-band runner telemetry.
 * Runners embed `ESC ] 6973 ; <json> BEL` in their PTY stream; this parser
 * strips those sequences out of the visible output and yields the parsed
 * events, handling sequences split across chunk boundaries.
 */
export class OscTelemetryParser {
  private carry = "";

  parse(chunk: string): { clean: string; events: TelemetryEvent[] } {
    let text = this.carry + chunk;
    this.carry = "";
    const events: TelemetryEvent[] = [];
    let clean = "";

    for (;;) {
      const start = text.indexOf(OSC_START);
      if (start === -1) {
        // Hold back a potential partial OSC prefix at the tail.
        const partial = partialSuffixLength(text, OSC_START);
        if (partial > 0) {
          clean += text.slice(0, text.length - partial);
          this.carry = text.slice(text.length - partial);
        } else {
          clean += text;
        }
        break;
      }
      const end = text.indexOf(BEL, start + OSC_START.length);
      if (end === -1) {
        clean += text.slice(0, start);
        this.carry = text.slice(start);
        if (this.carry.length > MAX_CARRY) {
          console.warn(
            `[argus] discarding ${this.carry.length}B unterminated OSC telemetry — misbehaving runner?`,
          );
          this.carry = "";
        }
        break;
      }
      clean += text.slice(0, start);
      const payload = text.slice(start + OSC_START.length, end);
      try {
        const parsed = telemetryEventSchema.safeParse(JSON.parse(payload));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // malformed telemetry is dropped silently; it must never break output
      }
      text = text.slice(end + 1);
    }
    return { clean, events };
  }
}

/** Length of the longest prefix of `needle` that is a suffix of `text`. */
function partialSuffixLength(text: string, needle: string): number {
  const max = Math.min(text.length, needle.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(needle.slice(0, len))) return len;
  }
  return 0;
}

/** Encode a telemetry event for embedding in PTY output (used by runners). */
export function encodeTelemetry(event: TelemetryEvent): string {
  return `${OSC_START}${JSON.stringify(event)}${BEL}`;
}
