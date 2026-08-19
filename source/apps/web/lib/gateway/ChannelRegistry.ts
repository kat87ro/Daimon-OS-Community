/**
 * The hot path. Maps channel id → xterm write sink as a plain module-level
 * Map, deliberately OUTSIDE React state: stdout frames route here at native
 * speed without ever triggering a render.
 */
export interface TerminalHandle {
  write(data: string): void;
  clear(): void;
  focus(): void;
  /** re-fit + repaint — call after the pane was hidden/covered and revealed,
   *  since xterm's WebGL buffer comes back blank with no size change to trigger
   *  the ResizeObserver. */
  refresh(): void;
}

const registry = new Map<string, TerminalHandle>();
/** Frames that arrive before the pane has mounted are parked here. */
const pending = new Map<string, string[]>();

export const channelRegistry = {
  register(channel: string, handle: TerminalHandle): void {
    registry.set(channel, handle);
    const queued = pending.get(channel);
    if (queued) {
      pending.delete(channel);
      for (const data of queued) handle.write(data);
    }
  },

  unregister(channel: string): void {
    registry.delete(channel);
  },

  write(channel: string, data: string): void {
    const handle = registry.get(channel);
    if (handle) {
      handle.write(data);
      return;
    }
    const queue = pending.get(channel) ?? [];
    queue.push(data);
    if (queue.length > 500) queue.shift(); // bounded
    pending.set(channel, queue);
  },

  clear(channel: string): void {
    registry.get(channel)?.clear();
    pending.delete(channel);
  },

  focus(channel: string): void {
    registry.get(channel)?.focus();
  },

  /** repaint one terminal (re-fit + force redraw) */
  refresh(channel: string): void {
    registry.get(channel)?.refresh();
  },

  /** repaint every mounted terminal — call when a hidden/covered grid is revealed */
  refreshAll(): void {
    for (const handle of registry.values()) handle.refresh();
  },

  drop(channel: string): void {
    registry.delete(channel);
    pending.delete(channel);
  },
};
