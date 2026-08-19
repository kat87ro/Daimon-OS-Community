#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * social-mcp — a worked example MCP server for the Daimon-OS credentials vault.
 *
 * It posts to a Facebook Page and an Instagram Business account via the Meta
 * Graph API, reading its tokens STRICTLY from environment variables:
 *
 *   FACEBOOK_PAGE_ID, FACEBOOK_PAGE_TOKEN   → post_facebook
 *   IG_USER_ID,       INSTAGRAM_TOKEN       → post_instagram
 *   GRAPH_API_VERSION (optional, default v21.0)
 *
 * Those env vars are exactly the vault secrets a project opts into: Daimon
 * injects them into the agent's process, and the agent's CLI passes them down to
 * this stdio server — so NO token is ever written into .mcp.json or any file on
 * disk. Add each as a Secret in the sidebar (key = the env var name above),
 * enable them on the project, and this server can post on the agent's behalf.
 *
 * Run: tsx packages/mcp/src/social.ts   (launched by the agent CLI via MCP config)
 */

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION ?? "v21.0"}`;

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

/** POST to a Graph API edge with form params; returns parsed JSON or throws. */
async function graphPost(
  edge: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params);
  const res = await fetch(`${GRAPH}/${edge}`, { method: "POST", body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = json.error as { message?: string } | undefined;
    throw new Error(`Graph API ${res.status}: ${err?.message ?? JSON.stringify(json)}`);
  }
  return json;
}

/** returns the missing names from the required env set, or [] if all present. */
function missingEnv(names: string[]): string[] {
  return names.filter((n) => !process.env[n]?.trim());
}

const server = new McpServer({ name: "social", version: "0.2.1" });

server.tool(
  "social_status",
  "Check which social credentials are available (presence only — never reveals the values). Call this first to confirm the vault secrets reached this server.",
  {},
  async () =>
    ok({
      graphApiVersion: process.env.GRAPH_API_VERSION ?? "v21.0",
      facebook: {
        ready: missingEnv(["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_TOKEN"]).length === 0,
        missing: missingEnv(["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_TOKEN"]),
      },
      instagram: {
        ready: missingEnv(["IG_USER_ID", "INSTAGRAM_TOKEN"]).length === 0,
        missing: missingEnv(["IG_USER_ID", "INSTAGRAM_TOKEN"]),
      },
      hint: "Add any missing names as Secrets in Daimon-OS (key = the env var name) and enable them on this project.",
    }),
);

server.tool(
  "post_facebook",
  "Publish a text post (optionally with a link) to the configured Facebook Page.",
  {
    message: z.string().min(1).describe("the post text"),
    link: z.string().url().optional().describe("optional URL to attach"),
  },
  async ({ message, link }) => {
    const missing = missingEnv(["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_TOKEN"]);
    if (missing.length) {
      return fail(
        `Missing Facebook credentials: ${missing.join(", ")}. Add them as vault secrets and enable them on this project.`,
      );
    }
    try {
      const result = await graphPost(`${process.env.FACEBOOK_PAGE_ID}/feed`, {
        message,
        ...(link ? { link } : {}),
        access_token: process.env.FACEBOOK_PAGE_TOKEN!,
      });
      return ok({ posted: true, ...result });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "post_instagram",
  "Publish an image post to the configured Instagram Business account. The image must be reachable at a public https URL (Instagram fetches it server-side).",
  {
    image_url: z.string().url().describe("public https URL of the image to post"),
    caption: z.string().optional().describe("optional caption text"),
  },
  async ({ image_url, caption }) => {
    const missing = missingEnv(["IG_USER_ID", "INSTAGRAM_TOKEN"]);
    if (missing.length) {
      return fail(
        `Missing Instagram credentials: ${missing.join(", ")}. Add them as vault secrets and enable them on this project.`,
      );
    }
    const igUser = process.env.IG_USER_ID!;
    const token = process.env.INSTAGRAM_TOKEN!;
    try {
      // 1) create a media container, 2) publish it (the two-step IG Graph flow)
      const container = await graphPost(`${igUser}/media`, {
        image_url,
        ...(caption ? { caption } : {}),
        access_token: token,
      });
      const creationId = container.id as string | undefined;
      if (!creationId) return fail(`no creation id returned: ${JSON.stringify(container)}`);
      const published = await graphPost(`${igUser}/media_publish`, {
        creation_id: creationId,
        access_token: token,
      });
      return ok({ posted: true, creationId, ...published });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
);

await server.connect(new StdioServerTransport());
