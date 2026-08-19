import os from "node:os";
import path from "node:path";
import type { ProviderKind } from "@daimon-os/shared";
import {
  ensureManagedDirectory,
  managedPathExists,
  writeManagedFileAtomic,
} from "../security/runtimeFiles";

/** which provider kinds have a native skill folder we can clone into —
 *  resolved lazily so os.homedir() reflects the current env, not import time */
function homeDir(): string {
  // honor $HOME explicitly — Node's os.homedir() reads getpwuid and ignores it,
  // which makes the clone path untestable and surprising under a custom HOME
  return process.env.HOME || os.homedir();
}

function skillHome(kind: ProviderKind): { root: string; relative: string } | undefined {
  if (kind === "claude") return { root: homeDir(), relative: path.join(".claude", "skills") };
  return undefined;
}

export const SKILL_CLONE_SUPPORTED: ProviderKind[] = ["claude"];

/**
 * Write a skill's SKILL.md into each supported provider's CLI home. Merge-only:
 * an existing skill dir there is left untouched (never clobber the user's own).
 * Returns the kinds actually written.
 */
export function cloneSkillToProviders(
  slug: string,
  content: string,
  kinds: ProviderKind[],
): ProviderKind[] {
  const safe = slug.replace(/[^a-z0-9-_]/gi, "-").slice(0, 64) || "skill";
  const written: ProviderKind[] = [];
  for (const kind of kinds) {
    const home = skillHome(kind);
    if (!home) continue; // unsupported kind — silently skip
    const relativeDir = path.join(home.relative, safe);
    if (managedPathExists(home.root, relativeDir)) continue; // never overwrite the user's existing skill
    ensureManagedDirectory(home.root, relativeDir);
    writeManagedFileAtomic(home.root, path.join(relativeDir, "SKILL.md"), content);
    written.push(kind);
  }
  return written;
}
