import type { LucideIcon } from "lucide-react";

/** A single renderable content block. The model is intentionally small so docs
 *  stay maintainable as structured data (and searchable — see sectionText). */
export type DocBlock =
  /** body paragraph */
  | { kind: "p"; text: string }
  /** sub-heading within a section */
  | { kind: "h"; text: string }
  /** ordered, numbered steps */
  | { kind: "steps"; items: string[] }
  /** unordered bullet list */
  | { kind: "list"; items: string[] }
  /** highlighted note — tone drives the colour/icon */
  | { kind: "callout"; tone: "info" | "tip" | "warn" | "security"; title?: string; text: string }
  /** a UI navigation breadcrumb, e.g. ["Configuration", "Providers"] */
  | { kind: "path"; segments: string[] }
  /** a row/grid of compact titled cards */
  | { kind: "cards"; items: Array<{ title: string; text: string }> }
  /** a definition list — used for file manifests and cause/fix pairs */
  | { kind: "kv"; title?: string; items: Array<{ k: string; v: string }> }
  /** monospace block (paths, commands, file trees) */
  | { kind: "code"; text: string }
  /** optional screenshot — drop the file in apps/web/public/docs/ and reference it as /docs/<file> */
  | { kind: "img"; src: string; alt: string; caption?: string };

export interface DocSection {
  /** stable slug — also the deep-link target ({type:"docs", section}) */
  id: string;
  title: string;
  icon: LucideIcon;
  blocks: DocBlock[];
}

/** A collapsible group in the left page tree. */
export interface DocGroup {
  label: string;
  sectionIds: string[];
}

/** Flatten a section's text for client-side search (title + every string field). */
export function sectionText(s: DocSection): string {
  const parts: string[] = [s.title];
  for (const b of s.blocks) {
    switch (b.kind) {
      case "p":
      case "code":
        parts.push(b.text);
        break;
      case "h":
        parts.push(b.text);
        break;
      case "steps":
      case "list":
        parts.push(...b.items);
        break;
      case "callout":
        if (b.title) parts.push(b.title);
        parts.push(b.text);
        break;
      case "path":
        parts.push(b.segments.join(" "));
        break;
      case "cards":
        for (const c of b.items) parts.push(c.title, c.text);
        break;
      case "kv":
        if (b.title) parts.push(b.title);
        for (const i of b.items) parts.push(i.k, i.v);
        break;
      case "img":
        parts.push(b.alt, b.caption ?? "");
        break;
    }
  }
  return parts.join(" \n ").toLowerCase();
}
