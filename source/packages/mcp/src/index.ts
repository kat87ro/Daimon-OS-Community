#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_SERVER_PORT } from "@daimon-os/shared";
import { GatewayClient } from "./gateway.js";

/**
 * daimon-os MCP server — the Team Lead's hands. Launched by the Lead's CLI via
 * --mcp-config / .mcp.json, scoped to one project + team through env. Every
 * tool is a thin call to the local gateway REST API; the server's scheduler
 * turns the tasks the Lead creates into running workers.
 */
const baseUrl = process.env.DAIMON_GATEWAY_URL ?? `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
const projectId = process.env.DAIMON_PROJECT_ID ?? "";
const teamId = process.env.DAIMON_TEAM_ID;
const gw = new GatewayClient(
  baseUrl,
  projectId,
  teamId,
  process.env.DAIMON_MCP_TOKEN,
);

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const server = new McpServer({ name: "daimon-os", version: "0.2.1" });

server.tool(
  "list_team",
  "List your team members and their roles, so you can assign tasks by capability.",
  {},
  async () => ok(await gw.listTeam()),
);

server.tool(
  "create_task",
  "Create a task and (optionally) assign it to a team member by name. dependsOn is a list of task ids that must finish first; the server runs independent tasks in parallel and holds dependent ones until their prerequisites are approved.",
  {
    title: z.string().min(1).max(4_096),
    description: z.string().max(256 * 1024).optional(),
    assignedAgentName: z.string().min(1).max(512).optional(),
    dependsOn: z.array(z.string().uuid()).max(256).optional(),
    lane: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    notBefore: z.string().datetime().optional(),
  },
  async (args) => ok(await gw.createTask(args)),
);

server.tool(
  "list_tasks",
  "List all tasks for this project with their current status, to track progress.",
  {},
  async () => ok(await gw.listTasks()),
);

server.tool(
  "get_task",
  "Get one task by id.",
  { id: z.string().uuid() },
  async ({ id }) => ok((await gw.getTask(id)) ?? { error: "not found" }),
);

server.tool(
  "update_task",
  "Update a task's status, description, scheduling lane, priority, or not-before timestamp before dispatch.",
  {
    id: z.string().uuid(),
    status: z.enum(["backlog", "blocked", "in_progress", "waiting_review"]).optional(),
    description: z.string().max(256 * 1024).optional(),
    lane: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    notBefore: z.string().datetime().optional(),
  },
  async ({ id, ...patch }) => ok(await gw.updateTask(id, patch)),
);

server.tool(
  "request_input",
  "Open an explicit durable operator-input request for a project task. Use only when essential information or a human decision is missing. This does not mark the task complete, consume worker review authority, or rely on waiting_tool telemetry. Reuse the same requestId for an HTTP retry.",
  {
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(4_096),
    options: z.array(z.string().trim().min(1).max(512)).max(16).optional(),
  },
  async ({ id, requestId, prompt, options }) => ok(await gw.requestInput(id, {
    requestId,
    prompt,
    options: options ?? [],
  })),
);

server.tool(
  "publish_artifact",
  "Publish a versioned, hash-addressed project artifact owned by the Lead. expectedVersion is 0 for a new artifact and prevents overwriting concurrent work.",
  {
    name: z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
    content: z.string().max(256 * 1024),
    mediaType: z.string().min(1).max(256).optional(),
    expectedVersion: z.number().int().nonnegative(),
  },
  async (args) => ok(await gw.publishArtifact(args)),
);

server.tool(
  "list_artifacts",
  "List the latest version of each owned project coordination artifact.",
  {},
  async () => ok(await gw.listArtifacts()),
);

server.tool(
  "read_artifact",
  "Read the latest version and verified content of one project coordination artifact.",
  { name: z.string().min(1).max(256) },
  async ({ name }) => ok(await gw.readArtifact(name)),
);

server.tool(
  "send_coordination_message",
  "Send an idempotent typed project message. Use exact team names for toAgentName and link an artifact by both name and version.",
  {
    idempotencyKey: z.string().min(1).max(512),
    kind: z.enum(["finding", "question", "answer", "handoff", "steering", "artifact", "status"]),
    body: z.string().min(1).max(256 * 1024),
    toAgentName: z.string().min(1).max(512).optional(),
    artifactName: z.string().min(1).max(256).optional(),
    artifactVersion: z.number().int().positive().optional(),
    causationId: z.string().min(1).max(256).optional(),
  },
  async (args) => ok(await gw.sendMessage(args)),
);

server.tool(
  "list_coordination_messages",
  "List typed project coordination messages with verified message bodies, optionally after an ISO timestamp.",
  { since: z.string().datetime().optional() },
  async ({ since }) => ok(await gw.listMessages(since)),
);

await server.connect(new StdioServerTransport());
