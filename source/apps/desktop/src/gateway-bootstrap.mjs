// utilityProcess entry: register the tsx ESM loader programmatically, then import
// the TypeScript gateway. We do NOT rely on `execArgv: ['--import','tsx']` —
// Electron's utilityProcess silently ignores that, so the .ts fails to load.
// tsx's register() installs the loader hooks for every subsequent import.
import { register } from "tsx/esm/api";
import path from "node:path";
import { pathToFileURL } from "node:url";

register();

const entry = path.resolve(import.meta.dirname, "..", "..", "server", "src", "desktop-entry.ts");
await import(pathToFileURL(entry).href);
