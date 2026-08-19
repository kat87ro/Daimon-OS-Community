// Embed-friendly gateway entry for the Electron desktop shell.
//
// Unlike index.ts (the standalone/LAN entry), this:
//   - binds an OS-assigned free port (DAIMON_PORT=0) and reports the ACTUAL bound
//     port back to the Electron main process over the utilityProcess MessagePort;
//   - expects host/origin/data-dir to be set by the parent (main.js forces
//     DAIMON_HOST=127.0.0.1 and pins DAIMON_ALLOWED_ORIGINS to the app:// origin);
//   - tears down on SIGTERM so quitting the app SIGKILLs every PTY.
import fs from "node:fs";
import { createApp } from "./app";

const port = Number(process.env.DAIMON_PORT ?? 0); // 0 → OS picks a free port
const dataDir = process.env.DAIMON_DATA_DIR || undefined;

// acquireInstanceLock writes its lockfile before ConfigStore would create the
// dir, so a first-run userData data dir must exist up front.
if (dataDir) fs.mkdirSync(dataDir, { recursive: true });

const app = await createApp({ port, dataDir });
// (createApp publishes the real bound port to process.env.DAIMON_PORT itself, so
// in-process readers see the authoritative port even with a configured override.)

// process.parentPort exists when launched via Electron's utilityProcess.fork.
// Fall back to a stdout sentinel when run as a plain node process (e.g. tests).
const parentPort = (process as unknown as {
  parentPort?: {
    postMessage(m: unknown): void;
  };
}).parentPort;

if (parentPort) {
  parentPort.postMessage({ type: "gateway-ready", port: app.port });
} else {
  process.stdout.write(`\n__DAIMON_GATEWAY_READY__ ${JSON.stringify({ port: app.port })}\n`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      // Ack the main process so it can call app.quit() instead of waiting for
      // the hard-kill timeout (see main.js before-quit handler).
      parentPort?.postMessage({ type: "gateway-closed" });
      process.exit(0);
    });
  });
}
