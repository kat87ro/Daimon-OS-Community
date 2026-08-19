"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { DEFAULT_SCROLLBACK_LINES } from "@daimon-os/shared";
import { channelRegistry } from "@/lib/gateway/ChannelRegistry";
import { gateway } from "@/lib/gateway/GatewayClient";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { PaneHeader } from "./PaneHeader";

const THEME = {
  // xterm needs literal hex (no Tailwind tokens); kept in sync with the design
  // tokens — panel bg #10151a, primary text #eef3f0
  background: "#10151a",
  foreground: "#eef3f0",
  cursor: "#e09a3e",
  selectionBackground: "#2a3550",
  black: "#1e2126",
  red: "#e07a7a",
  green: "#62c98c",
  yellow: "#e0a14f",
  blue: "#6da7e8",
  magenta: "#c08ae0",
  cyan: "#5ec2d6",
  white: "#eef3f0",
  brightBlack: "#707984",
};

export function TerminalPane({ channel, embedded = false }: { channel: string; embedded?: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const focused = useLayoutStore((s) => s.focusedChannel === channel);
  const setFocused = useLayoutStore((s) => s.setFocused);
  const session = useSessionStore((s) => s.sessions[channel]);
  const scrollback =
    useConfigStore((s) => s.settings?.scrollbackLines) ?? DEFAULT_SCROLLBACK_LINES;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    // phones get a ~15% smaller font so far more of the agent's output fits on
    // screen without pinch-zooming (xterm's FitAddon then packs in more cols/rows)
    const isMobile =
      typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    const term = new Terminal({
      theme: THEME,
      fontSize: isMobile ? 10 : 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let disposed = false;
    // fitting a zero-size or detached container crashes xterm's viewport
    // ("reading 'dimensions'") — guard every fit behind layout existence
    const safeFit = () => {
      if (disposed || !el.isConnected || el.clientWidth < 2 || el.clientHeight < 2) return;
      try {
        fit.fit();
      } catch {
        // mid-dispose race — next ResizeObserver tick will retry
      }
    };
    // WebGL init must happen after the element has been laid out (clientWidth > 0).
    // term.open() is synchronous but the browser hasn't painted yet at that point,
    // so WebglAddon reads zero dimensions and crashes. Defer to rAF.
    requestAnimationFrame(() => {
      if (disposed) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose()); // fall back to canvas renderer
        term.loadAddon(webgl);
      } catch {
        // WebGL unavailable — xterm's DOM renderer still works
      }
      safeFit();
    });

    // re-fit then force a full repaint — fixes the blank/black canvas when a
    // pane is revealed after being covered (overlay) or hidden, where no size
    // change fires the ResizeObserver to redraw the WebGL buffer
    const refresh = () => {
      if (disposed) return;
      safeFit();
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // mid-dispose race — ignore
      }
    };

    const onData = term.onData((data) => gateway.sendStdin(channel, data));
    channelRegistry.register(channel, {
      write: (data) => {
        if (!disposed) term.write(data);
      },
      clear: () => {
        if (!disposed) term.clear();
      },
      focus: () => {
        if (!disposed) term.focus();
      },
      refresh,
    });

    // xterm's selection service stops propagation of real mouse events, so a
    // React onMouseUp on the wrapper never fires for trusted clicks — without
    // this, clicking a terminal leaves keyboard focus on <body> and typing
    // goes nowhere. Capture phase runs before xterm can swallow the event.
    const focusOnMouseUp = () => {
      if (!disposed) term.focus();
    };
    el.addEventListener("mouseup", focusOnMouseUp, { capture: true });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        safeFit();
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // mid-dispose race — ignore
        }
        gateway.sendResize(channel, term.cols, term.rows);
      }, 80);
    });
    observer.observe(el);

    return () => {
      disposed = true;
      el.removeEventListener("mouseup", focusOnMouseUp, { capture: true });
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      onData.dispose();
      channelRegistry.unregister(channel);
      term.dispose();
    };
  }, [channel, scrollback]);

  return (
    <div
      onMouseDown={() => setFocused(channel)}
      className={clsx(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-panel",
        focused ? "border-amber" : "border-line",
      )}
    >
      <PaneHeader channel={channel} embedded={embedded} />
      <div className="relative min-h-0 flex-1">
        {session && session.kind !== "shell" && (
          // the floating identity bar: who is working in this pane
          <div className="pointer-events-none absolute right-2 top-1.5 z-10 rounded border border-plum/40 bg-ink/80 px-2 py-0.5 font-sans text-[11px] text-text">
            <span className="text-plum">{session.agentName}</span>
            {session.role && <span className="text-soft"> — {session.role}</span>}
          </div>
        )}
        <div
          ref={bodyRef}
          // belt-and-braces: explicitly hand keyboard focus to xterm — relying
          // on its internal click handler proved fragile inside the grid
          onMouseUp={() => channelRegistry.focus(channel)}
          className="daimon-term h-full px-1.5 py-1"
        />
      </div>
    </div>
  );
}
