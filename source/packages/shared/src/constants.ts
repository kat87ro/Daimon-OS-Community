export const PROTOCOL_VERSION = 1 as const;

/** Reserved channel for connection-level control traffic (not tied to an agent run). */
export const GATEWAY_CHANNEL = "gateway" as const;

// Deliberately abnormal, patterned port — easy to spot as Daimon's in lsof/logs
// and clear of the common dev-port neighborhood (3000/4040/5000/8080) and the
// 32400 Plex range. The desktop app binds an OS-assigned free port (DAIMON_PORT=0)
// regardless; this is the dev/standalone bind port and the ultimate fallback, so
// a stray fallback can never silently collide with a normal service.
export const DEFAULT_SERVER_PORT = 41414;
export const GATEWAY_WS_PATH = "/gateway";

/** Output batching: flush a channel's PTY output on whichever limit hits first. */
export const FLUSH_INTERVAL_MS = 16;
export const FLUSH_MAX_BYTES = 8 * 1024;

/** Socket backpressure: pause PTYs above high water, resume below low water. */
export const WS_HIGH_WATER_BYTES = 1024 * 1024;
export const WS_LOW_WATER_BYTES = 256 * 1024;
/** Hard inbound WebSocket message ceiling. Enforced both by ws and the decoder. */
export const WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Terminal geometry and high-risk client string ceilings. */
export const MAX_TERMINAL_COLS = 1_000;
export const MAX_TERMINAL_ROWS = 1_000;
export const MAX_STDIN_BYTES = 64 * 1024;
export const MAX_TASK_PROMPT_BYTES = 256 * 1024;

/** Per-channel replay ring buffer caps (whichever hits first evicts oldest). */
export const RING_MAX_BYTES = 256 * 1024;
export const RING_MAX_FRAMES = 2000;
/** Keep a finished run's ring buffer around so late clients can read final output. */
export const RING_RETENTION_MS = 5 * 60 * 1000;
/** Hard cap on exited-but-retained processes; oldest is evicted beyond this. */
export const MAX_RETAINED_PROCS = 32;

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

export const METRICS_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 16;
export const DEFAULT_SCROLLBACK_LINES = 5_000;

/** Watchdog: an in_progress worker silent this long is flagged idle (surface-only). */
export const DEFAULT_WATCHDOG_IDLE_MS = 10 * 60 * 1000;
/** How often the watchdog sweeps for idle workers. */
export const WATCHDOG_SWEEP_MS = 30_000;
/** Auto-retry a failed/crashed task this many times before requiring manual retry. */
export const DEFAULT_MAX_AUTO_RETRIES = 1;
/** How often the cost tracker re-reads live Claude transcripts for token/cost. */
export const COST_POLL_MS = 4_000;

/** In-band telemetry: runners embed `ESC ] 6973 ; <json> BEL` in PTY output. */
export const TELEMETRY_OSC_CODE = 6973;

/** Whimsical run-status labels, BridgeMind style. */
export const SPINNER_LABELS = [
  "Gallianting",
  "Coalescing",
  "Brewing",
  "Cogitating",
  "Churning",
  "Conjuring",
  "Percolating",
  "Daimoning",
] as const;

export const DONE_LABELS = [
  "Crunched",
  "Cooked",
  "Cogitated",
  "Churned",
  "Worked",
  "Conjured",
] as const;
