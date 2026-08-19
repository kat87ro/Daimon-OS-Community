import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LINUX_SIGNING_ANCHOR = fileURLToPath(
  new URL("../release/linux-signing-key.sha256", import.meta.url),
);

function requireFingerprint(value, label, { lowercase = false } = {}) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 64-character SHA-256 hexadecimal digest`);
  }
  if (lowercase && value !== value.toLowerCase()) {
    throw new Error(`${label} must use lowercase hexadecimal`);
  }
  return value.toLowerCase();
}

export function readCommittedAnchor(anchorPath = LINUX_SIGNING_ANCHOR) {
  const raw = fs.readFileSync(anchorPath, "utf8");
  const value = raw.trim();
  if (raw !== value && raw !== `${value}\n`) {
    throw new Error("committed Linux signing fingerprint anchor must contain exactly one line");
  }
  if (value === "UNCONFIGURED") {
    throw new Error(
      "committed Linux signing fingerprint anchor is UNCONFIGURED; tagged releases are blocked",
    );
  }
  return requireFingerprint(value, "committed Linux signing fingerprint anchor", { lowercase: true });
}

export function publicKeyFingerprint(publicKeyPath) {
  const publicKey = createPublicKey(fs.readFileSync(publicKeyPath));
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export function verifyLinuxSigningAnchor({
  anchorPath = LINUX_SIGNING_ANCHOR,
  protectedFingerprint,
  publicKeyPath,
}) {
  const anchor = readCommittedAnchor(anchorPath);
  const protectedValue = requireFingerprint(
    protectedFingerprint?.trim() ?? "",
    "LINUX_SIGNING_KEY_FINGERPRINT",
  );
  if (protectedValue !== anchor) {
    throw new Error(
      "protected Linux signing fingerprint does not match the committed trust anchor",
    );
  }
  if (publicKeyPath) {
    const derived = publicKeyFingerprint(path.resolve(publicKeyPath));
    if (derived !== anchor) {
      throw new Error(
        "Linux signing private key-derived public key does not match the committed trust anchor",
      );
    }
  }
  return anchor;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const anchor = verifyLinuxSigningAnchor({
      protectedFingerprint: process.env.LINUX_SIGNING_KEY_FINGERPRINT,
      publicKeyPath: process.argv[2],
    });
    process.stdout.write(`Linux signing trust anchor verified: ${anchor}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
