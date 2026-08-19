import fs from "node:fs";
import path from "node:path";

/**
 * Single-writer guard on the data dir. Two server instances sharing one
 * config.json clobber each other (stale in-memory state overwrites on the next
 * upsert) — exactly the failure that lost a project during testing. This
 * refuses to start a second LIVE instance pointed at the same data dir.
 *
 * A stale lock (process gone) is reclaimed. Returns a release() to call on
 * shutdown. Set DAIMON_NO_LOCK=1 to bypass (e.g. parallel test workers using
 * their own temp data dirs already can't collide).
 */
export function acquireInstanceLock(dataDir: string): () => void {
  if (process.env.DAIMON_NO_LOCK === "1") return () => {};
  const lockPath = path.join(dataDir, ".server.lock");

  if (fs.existsSync(lockPath)) {
    const prev = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (prev && prev !== process.pid && isAlive(prev)) {
      throw new Error(
        `another Daimon-OS server (pid ${prev}) is already using ${dataDir}. ` +
          `Stop it first — two instances clobber config.json. (DAIMON_NO_LOCK=1 to override.)`,
      );
    }
    // stale lock from a dead process — reclaim it
  }
  fs.writeFileSync(lockPath, String(process.pid), "utf8");

  const release = () => {
    try {
      if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // best effort
    }
  };
  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.once(sig, release);
  }
  return release;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}
