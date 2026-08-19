import { rebuild } from "@electron/rebuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export default async function stageLinuxNative({ appDir, electronVersion, platform, arch }) {
  if (platform !== "linux") return true;
  if (process.platform !== "linux") {
    throw new Error("Linux packages must be built on Linux so node-pty is compiled for Linux");
  }

  await rebuild({
    buildPath: appDir,
    electronVersion,
    arch,
    force: true,
    onlyModules: ["node-pty"],
  });

  const moduleDir = path.join(appDir, "node_modules", "node-pty");
  const targetDir = path.join(moduleDir, "prebuilds", `linux-${arch}`);
  await mkdir(targetDir, { recursive: true });
  await copyFile(
    path.join(moduleDir, "build", "Release", "pty.node"),
    path.join(targetDir, "pty.node"),
  );

  // The Linux Electron-ABI binary is staged as a prebuild, so electron-builder
  // must not perform a second dependency rebuild after this hook.
  return false;
}
