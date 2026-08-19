"use client";

import { useEffect } from "react";

/** registers the service worker so Daimon-OS is installable as a standalone app */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // Desktop (Electron) build: no service worker. SWs don't register on app://
    // and a stale SW could cache a wrong gateway port. Skip entirely.
    if ((window as unknown as { __DAIMON_DESKTOP__?: boolean }).__DAIMON_DESKTOP__) return;
    if (!window.location.protocol.startsWith("http")) return;
    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
