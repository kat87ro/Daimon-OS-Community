#!/usr/bin/env node
/**
 * Generate platform app icons from the Higgsfield master PNG.
 * Requires macOS sips + iconutil (Xcode CLI tools).
 * Run from the monorepo root: node apps/desktop/scripts/gen-icons.mjs
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, "..", "build");

// ── 1. Validate the source master ────────────────────────────────────────────
const masterPng = join(BUILD, "master.png");
if (!existsSync(masterPng)) {
  throw new Error(`Missing icon master: ${masterPng}`);
}
console.log("✓ Higgsfield master.png found");

// ── 2. macOS ICNS ─────────────────────────────────────────────────────────────
const iconset = join(BUILD, "icon.iconset");
mkdirSync(iconset, { recursive: true });

const macSizes = [
  [16,   "icon_16x16.png"],
  [32,   "icon_16x16@2x.png"],
  [32,   "icon_32x32.png"],
  [64,   "icon_32x32@2x.png"],
  [128,  "icon_128x128.png"],
  [256,  "icon_128x128@2x.png"],
  [256,  "icon_256x256.png"],
  [512,  "icon_256x256@2x.png"],
  [512,  "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

for (const [size, name] of macSizes) {
  execSync(
    `sips -z ${size} ${size} "${masterPng}" --out "${join(iconset, name)}"`,
    { stdio: "inherit" },
  );
}
execSync(`iconutil -c icns "${iconset}" -o "${join(BUILD, "icon.icns")}"`, { stdio: "inherit" });
console.log("✓ icon.icns created");

// ── 3. Linux PNG set ──────────────────────────────────────────────────────────
const linuxIcons = join(BUILD, "icons");
mkdirSync(linuxIcons, { recursive: true });

for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  execSync(
    `sips -z ${size} ${size} "${masterPng}" --out "${join(linuxIcons, `${size}x${size}.png`)}"`,
    { stdio: "inherit" },
  );
}
console.log("✓ Linux PNG set created");

// ── 4. Windows ICO (pure-Node ICO encoder) ────────────────────────────────────
// ICO format: https://en.wikipedia.org/wiki/ICO_(file_format)
// We embed 16, 32, 48, 256 px PNG images directly (modern ICO supports embedded PNG).
const icoSizes = [16, 32, 48, 256];
const pngBuffers = icoSizes.map((s) => {
  const tmp = join(BUILD, `_ico_${s}.png`);
  execSync(`sips -z ${s} ${s} "${masterPng}" --out "${tmp}"`, { stdio: "inherit" });
  const buf = readFileSync(tmp);
  execSync(`rm -f "${tmp}"`);
  return buf;
});

// ICO header: 6 bytes
// Directory entries: 16 bytes × N
// Then PNG data blobs
const headerSize = 6;
const dirEntrySize = 16;
const dirSize = dirEntrySize * icoSizes.length;
const headerBuf = Buffer.alloc(headerSize);
headerBuf.writeUInt16LE(0, 0);   // reserved
headerBuf.writeUInt16LE(1, 2);   // type = ICO
headerBuf.writeUInt16LE(icoSizes.length, 4);

let offset = headerSize + dirSize;
const dirBufs = pngBuffers.map((png, i) => {
  const sz = icoSizes[i];
  const entry = Buffer.alloc(dirEntrySize);
  entry.writeUInt8(sz >= 256 ? 0 : sz, 0);   // width (0 = 256+)
  entry.writeUInt8(sz >= 256 ? 0 : sz, 1);   // height
  entry.writeUInt8(0, 2);   // color count
  entry.writeUInt8(0, 3);   // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  return entry;
});

const ico = Buffer.concat([headerBuf, ...dirBufs, ...pngBuffers]);
writeFileSync(join(BUILD, "icon.ico"), ico);
console.log("✓ icon.ico created");

console.log("\nAll icons generated in apps/desktop/build/");
