import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encrypted-at-rest secret store. Values are sealed with AES-256-GCM under a
 * 32-byte master key kept in a 0600 `vault.key` file in the data dir; the
 * ciphertext lives in `vault.enc` (also 0600), keyed by an opaque id. The plain
 * value never touches config.json or the wire — callers store/resolve by id.
 *
 * Threat model (per the chosen design): the 0600 key file sits beside the data,
 * so this protects against casual reading, accidental git commits, and backups
 * of config — NOT against an attacker who already has full read access to the
 * data dir. (A Keychain/passphrase-derived key would raise that bar; this is the
 * deliberate "no unlock prompt, works headless" trade.)
 */
export class Vault {
  private readonly keyPath: string;
  private readonly storePath: string;
  private readonly key: Buffer;
  /** id → "ivB64:tagB64:ctB64" */
  private store: Record<string, string>;

  constructor(dataDir: string) {
    this.keyPath = path.join(dataDir, "vault.key");
    this.storePath = path.join(dataDir, "vault.enc");
    this.key = this.loadOrCreateKey();
    this.store = this.loadStore();
  }

  private loadOrCreateKey(): Buffer {
    if (fs.existsSync(this.keyPath)) {
      fs.chmodSync(this.keyPath, 0o600); // heal perms on a pre-existing key
      const raw = fs.readFileSync(this.keyPath, "utf8").trim();
      const buf = Buffer.from(raw, "base64");
      if (buf.length === 32) return buf;
      // corrupt/short key — fail loud rather than silently re-keying (which would
      // make every existing ciphertext undecryptable without warning)
      throw new Error(`vault.key is malformed (${buf.length} bytes, expected 32)`);
    }
    const key = crypto.randomBytes(32);
    // write 0600 atomically so a half-written key can't brick the vault
    const tmp = `${this.keyPath}.tmp`;
    fs.writeFileSync(tmp, key.toString("base64") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.keyPath);
    fs.chmodSync(this.keyPath, 0o600);
    return key;
  }

  private loadStore(): Record<string, string> {
    if (!fs.existsSync(this.storePath)) return {};
    fs.chmodSync(this.storePath, 0o600);
    try {
      return JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Record<string, string>;
    } catch {
      return {}; // unreadable store — start empty rather than crash the server
    }
  }

  private persist(): void {
    const tmp = `${this.storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.storePath);
    fs.chmodSync(this.storePath, 0o600);
  }

  has(id: string): boolean {
    return id in this.store;
  }

  /** decrypt and return the raw value, or undefined if absent/tampered. */
  get(id: string): string | undefined {
    const sealed = this.store[id];
    if (!sealed) return undefined;
    const [ivB64, tagB64, ctB64] = sealed.split(":");
    if (!ivB64 || !tagB64 || !ctB64) return undefined;
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(ivB64, "base64"),
      );
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      const out = Buffer.concat([
        decipher.update(Buffer.from(ctB64, "base64")),
        decipher.final(),
      ]);
      return out.toString("utf8");
    } catch {
      return undefined; // wrong key or tampered ciphertext
    }
  }

  set(id: string, plaintext: string): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.store[id] = `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
    this.persist();
  }

  delete(id: string): void {
    if (id in this.store) {
      delete this.store[id];
      this.persist();
    }
  }

  /** Drop every secret (factory reset). The master key is kept, so the vault is
   *  immediately reusable for newly-added secrets. */
  clear(): void {
    if (Object.keys(this.store).length === 0) return;
    this.store = {};
    this.persist();
  }
}
