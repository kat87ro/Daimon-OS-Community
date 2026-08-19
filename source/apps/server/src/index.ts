import os from "node:os";
import { DEFAULT_SERVER_PORT, GATEWAY_WS_PATH } from "@daimon-os/shared";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);

const app = await createApp({ port });

/** every non-internal IPv4 address — so you know what to open on your phone */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const host = process.env.DAIMON_HOST ?? "127.0.0.1";
console.log(`⚡ Daimon-OS gateway listening on http://127.0.0.1:${app.port}`);
console.log(`   REST:         http://127.0.0.1:${app.port}/api/health`);
console.log(`   Charon (WS):  ws://127.0.0.1:${app.port}${GATEWAY_WS_PATH}`);
if (host !== "127.0.0.1" && host !== "localhost") {
  const lan = lanAddresses();
  console.log(
    `   LAN access:   ${lan.map((ip) => `http://${ip}:${app.port}`).join("  ") || "(no LAN interface found)"}`,
  );
  console.log(
    `   📱 On your phone open the WEB app at  http://<lan-ip>:3777  (e.g. http://${lan[0] ?? "192.168.x.x"}:3777)`,
  );
  console.log(`   🔐 LAN access requires DAIMON_AUTH_TOKEN.`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
