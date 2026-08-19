import { DEFAULT_SERVER_PORT, GATEWAY_WS_PATH } from "@daimon-os/shared";

/** port the gateway listens on (override with NEXT_PUBLIC_DAIMON_PORT) */
const SERVER_PORT = process.env.NEXT_PUBLIC_DAIMON_PORT ?? String(DEFAULT_SERVER_PORT);

/**
 * Resolve the gateway base URL **at call time** — NOT at module load — so the
 * Electron desktop build can inject the gateway's OS-assigned free port via the
 * preload bridge (`window.__DAIMON_PORT__`) after this bundle has loaded. (A
 * static export has no server to bake env into, and the renderer's own origin is
 * `app://`, so the legacy module-load resolution produced a wrong, frozen URL.)
 *
 * Precedence:
 *   1. window.__DAIMON_PORT__   — desktop: gateway at 127.0.0.1:<free port>
 *   2. NEXT_PUBLIC_DAIMON_SERVER — explicit full-origin override
 *   3. http(s) window.location  — LAN/phone web build (host:3777 → host:<SERVER_PORT>)
 *   4. http://127.0.0.1:<port>  — SSR / build / app:// before port injection
 */
export function serverHttp(): string {
  if (typeof window !== "undefined") {
    const injected = (window as unknown as { __DAIMON_PORT__?: number | null }).__DAIMON_PORT__;
    if (typeof injected === "number" && injected > 0) return `http://127.0.0.1:${injected}`;
  }
  if (process.env.NEXT_PUBLIC_DAIMON_SERVER) return process.env.NEXT_PUBLIC_DAIMON_SERVER;
  if (
    typeof window !== "undefined" &&
    window.location?.hostname &&
    window.location.protocol.startsWith("http") // ignore app:// / file://
  ) {
    return `${window.location.protocol}//${window.location.hostname}:${SERVER_PORT}`;
  }
  return `http://127.0.0.1:${SERVER_PORT}`;
}

/** WebSocket URL for the Charon gateway, resolved at call time (see serverHttp). */
export function gatewayWsUrl(): string {
  return serverHttp().replace(/^http/, "ws") + GATEWAY_WS_PATH;
}

/** Desktop preload injects this at runtime; plain web deployments may inject it
 *  before the bundle starts. Never put the token in URLs or application logs. */
export function gatewayAuthToken(): string | undefined {
  const injected = typeof window === "undefined"
    ? undefined
    : (window as unknown as { __DAIMON_AUTH_TOKEN__?: string | null }).__DAIMON_AUTH_TOKEN__;
  // DAIMON_AUTH_TOKEN is the native/server administrator bearer and must never
  // be included in a browser bundle. Browser clients receive only the separate
  // renderer bearer through preload or NEXT_PUBLIC_DAIMON_AUTH_TOKEN.
  const token = injected ?? process.env.NEXT_PUBLIC_DAIMON_AUTH_TOKEN;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export function gatewayWsProtocols(): string[] {
  const token = gatewayAuthToken();
  if (!token) return ["daimon-v1"];
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return ["daimon-v1", `daimon-auth.${encoded}`];
}
