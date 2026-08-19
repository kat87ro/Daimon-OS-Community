import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const adminToken = randomBytes(32).toString("base64url");
const rendererToken = randomBytes(32).toString("base64url");
const env = {
  ...process.env,
  DAIMON_AUTH_TOKEN: adminToken,
  DAIMON_RENDERER_TOKEN: rendererToken,
  NEXT_PUBLIC_DAIMON_AUTH_TOKEN: rendererToken,
  DAIMON_HOST: "127.0.0.1",
};
if (env.DAIMON_AUTH_TOKEN === env.NEXT_PUBLIC_DAIMON_AUTH_TOKEN) {
  throw new Error("the admin bearer must never be exposed as a public web token");
}
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = [
  spawn(pnpm, ["--filter", "@daimon-os/server", "dev"], { env, stdio: "inherit" }),
  spawn(pnpm, ["--filter", "@daimon-os/web", "dev"], { env, stdio: "inherit" }),
];

let stopping = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(`[dev] ${error.message}`);
    stop();
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`[dev] child exited (${signal ?? code})`);
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
