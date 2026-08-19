import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Repository contents are untrusted. App-managed runtime files must never pass
 * through a repository-controlled symlink, even when their lexical path looks
 * contained. These helpers validate every component against the real checkout
 * root and fail closed on links or unexpected file types.
 */
export class ManagedRuntimePathError extends Error {}

export function managedPathExists(root: string, relative: string): boolean {
  const resolvedRoot = realDirectory(root);
  const parts = relativeParts(relative);
  let cursor = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    if (!fs.existsSync(cursor)) return false;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new ManagedRuntimePathError(`managed runtime path contains a symlink: ${relative}`);
    const final = index === parts.length - 1;
    if (!final && !stat.isDirectory()) {
      throw new ManagedRuntimePathError(`managed runtime parent is not a directory: ${relative}`);
    }
    assertRealContained(resolvedRoot, cursor);
  }
  return true;
}

export function ensureManagedDirectory(root: string, relative: string): string {
  const resolvedRoot = realDirectory(root);
  const parts = relativeParts(relative);
  let cursor = resolvedRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ManagedRuntimePathError(`managed runtime directory is unsafe: ${relative}`);
    }
    assertRealContained(resolvedRoot, cursor);
  }
  return cursor;
}

export function readManagedText(root: string, relative: string): string | undefined {
  if (!managedPathExists(root, relative)) return undefined;
  const target = managedFile(root, relative);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new ManagedRuntimePathError(`managed runtime file is unsafe: ${relative}`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function writeManagedFileAtomic(
  root: string,
  relative: string,
  content: string | Buffer,
): string {
  const resolvedRoot = realDirectory(root);
  const parts = relativeParts(relative);
  const fileName = parts.pop()!;
  const parentRelative = parts.join(path.sep);
  const parent = parts.length ? ensureManagedDirectory(resolvedRoot, parentRelative) : resolvedRoot;
  const target = path.join(parent, fileName);
  assertSafeExistingFile(resolvedRoot, target, relative);

  const temp = path.join(parent, `.${fileName}.daimon-${process.pid}-${randomUUID()}.tmp`);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Revalidate after writing the temporary file to narrow parent/target races.
    assertRealContained(resolvedRoot, parent);
    assertSafeExistingFile(resolvedRoot, target, relative);
    fs.renameSync(temp, target);
    assertSafeExistingFile(resolvedRoot, target, relative, true);
    return target;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

export function removeManagedPath(root: string, relative: string): void {
  if (!managedPathExists(root, relative)) return;
  const resolvedRoot = realDirectory(root);
  const target = path.join(resolvedRoot, ...relativeParts(relative));
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new ManagedRuntimePathError(`refusing to remove managed symlink: ${relative}`);
  assertRealContained(resolvedRoot, target);
  fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
}

function managedFile(root: string, relative: string): string {
  const resolvedRoot = realDirectory(root);
  const target = path.join(resolvedRoot, ...relativeParts(relative));
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ManagedRuntimePathError(`managed runtime file is unsafe: ${relative}`);
  }
  assertRealContained(resolvedRoot, target);
  return target;
}

function assertSafeExistingFile(
  root: string,
  target: string,
  relative: string,
  required = false,
): void {
  if (!fs.existsSync(target)) {
    if (required) throw new ManagedRuntimePathError(`managed runtime file disappeared: ${relative}`);
    return;
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ManagedRuntimePathError(`managed runtime file is unsafe: ${relative}`);
  }
  assertRealContained(root, target);
}

function realDirectory(input: string): string {
  const resolved = fs.realpathSync.native(input);
  if (!fs.statSync(resolved).isDirectory()) throw new ManagedRuntimePathError("managed runtime root is not a directory");
  return resolved;
}

function relativeParts(relative: string): string[] {
  if (!relative || path.isAbsolute(relative)) throw new ManagedRuntimePathError("managed runtime path must be relative");
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new ManagedRuntimePathError(`invalid managed runtime path: ${relative}`);
  }
  return parts;
}

function assertRealContained(root: string, target: string): void {
  const real = fs.realpathSync.native(target);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new ManagedRuntimePathError("managed runtime path escaped the checkout");
  }
}
