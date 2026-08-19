import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function realDirectory(input: string): string {
  if (!path.isAbsolute(input)) throw new Error("project path must be absolute");
  const real = fs.realpathSync.native(input);
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${input}`);
  return real;
}

/** Canonicalize and reject roots whose approval would expose an entire account/OS. */
export function approveProjectRoot(input: string): string {
  let real: string;
  try {
    real = realDirectory(input);
  } catch {
    throw new Error(`not a readable directory: ${input}`);
  }
  const parsed = path.parse(real);
  const broad = new Set([
    parsed.root,
    os.homedir(),
    fs.realpathSync.native(os.tmpdir()),
    path.dirname(os.homedir()),
  ]);
  if (broad.has(real)) {
    throw new Error(`project path is too broad: ${input}`);
  }
  return real;
}

/** Resolve a spawn cwd and prove it remains under the selected project root. */
export function resolveProjectCwd(projectRoot: string, requestedCwd?: string): string {
  const root = realDirectory(projectRoot);
  const target = realDirectory(requestedCwd ?? root);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("working directory does not belong to the selected project");
  }
  return target;
}
/** Resolve an existing file and reject symlink traversal outside the project. */
export function resolveProjectFile(projectRoot: string, relativePath: string): string {
  const root = realDirectory(projectRoot);
  if (path.isAbsolute(relativePath)) throw new Error("path must be project-relative");
  const lexical = path.resolve(root, relativePath);
  if (lexical !== root && !lexical.startsWith(root + path.sep)) {
    throw new Error("path escapes project folder");
  }
  const target = fs.realpathSync.native(lexical);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error("path escapes project folder");
  }
  return target;
}
