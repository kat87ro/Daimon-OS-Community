// Daimon-OS desktop shell — Electron main process.
//
// Responsibilities:
//   1. Spawn the Charon gateway in a utilityProcess on an OS-assigned free port,
//      bound to 127.0.0.1 with the app:// origin pinned (never inherit 0.0.0.0).
//   2. Serve the statically-exported Next dashboard over a custom app:// scheme.
//   3. Inject the gateway port into the renderer via the preload bridge.
//   4. On quit, ask the gateway to close gracefully (pm.shutdown → docker rm -f +
//      PTY SIGKILLs), then hard-kill after a 10 s timeout.
const { app, BrowserWindow, Menu, protocol, utilityProcess, ipcMain, net, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { buildMenu } = require("./menu");

// A Finder/Dock-launched macOS app inherits only the bare /etc/paths PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — NOT the user's shell additions. The gateway
// spawns provider CLIs (claude/gemini/codex) and `node` by name, so without the
// real PATH they're "not found" and every agent exits code 1. Resolve the login
// shell's PATH once and merge it (plus common bin dirs) into the gateway env.
function resolveAgentPath() {
  const commonDirs = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(app.getPath("home"), ".local/bin"),
    path.join(app.getPath("home"), ".nvm/current/bin"),
    path.join(app.getPath("home"), ".bun/bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  let shellPath = "";
  if (process.platform !== "win32") {
    try {
      const shell = process.env.SHELL || "/bin/zsh";
      // login + interactive so .zprofile/.zshrc (where PATH is usually set) run;
      // print only PATH on the last line to avoid MOTD/banner noise.
      const out = execFileSync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      shellPath = out.trim().split("\n").pop() || "";
    } catch {
      /* shell query failed — fall back to common dirs + inherited PATH */
    }
  }
  const merged = [shellPath, process.env.PATH, ...commonDirs]
    .filter(Boolean)
    .join(path.delimiter)
    .split(path.delimiter)
    .filter(Boolean);
  return [...new Set(merged)].join(path.delimiter); // dedupe, preserve order
}
const AGENT_PATH = resolveAgentPath();

const ROOT = path.resolve(__dirname, "..", "..", "..");

// Packaged vs dev paths.
// In a signed/distributed build the asar is read-only; resources live under
// process.resourcesPath. In dev we read directly from the source tree.
const WEB_OUT = app.isPackaged
  ? path.join(process.resourcesPath, "web-out")
  : path.join(ROOT, "apps", "web", "out");

// Dev: tsx bootstrap loads TypeScript at runtime (gateway-bootstrap.mjs).
// Packaged: esbuild ESM bundle — all server deps inlined; node-pty external.
// The bundle uses `import { createRequire } from 'module'` as a banner so that
// CJS sub-deps (fastify/avvio) can call require() from inside the ESM module.
const GATEWAY_ENTRY = app.isPackaged
  ? path.join(__dirname, "gateway.mjs")
  : path.join(__dirname, "gateway-bootstrap.mjs");

// daimon-os MCP server entry handed to spawned agents' .mcp.json.
// Packaged: a standalone esbuild bundle (mcp-server.mjs) shipped as an extra
// resource and run with plain `node` — the spawned `claude` CLI launches it as a
// child process, so it must live OUTSIDE the asar (a non-Electron node can't read
// asar). Dev: left unset so lead.ts resolves the TypeScript source and runs it
// via tsx. lead.ts keys "bundled vs source" off the .mjs/.js extension.
const MCP_ENTRY = app.isPackaged
  ? path.join(process.resourcesPath, "mcp-server.mjs")
  : undefined;

const APP_ORIGIN = "app://daimon";
const DAIMON_AUTH_TOKEN = randomBytes(32).toString("base64url");
const DAIMON_RENDERER_TOKEN = randomBytes(32).toString("base64url");

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "daimon-os.com" || hostname.endsWith(".daimon-os.com") ||
      hostname === "github.com" || hostname === "api.github.com";
  } catch {
    return false;
  }
}

async function openAllowedExternal(value) {
  if (!isAllowedExternalUrl(value)) throw new Error("external URL is not allowed");
  await shell.openExternal(value);
}

// CSP for the app:// renderer.
// 'unsafe-inline' for script/style is required by Next.js static export (inline
// JSON hydration chunks + inlined critical CSS). Phase 2 can add hash-based CSP.
// connect-src pins WS + HTTP to the loopback gateway on its dynamic port.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

const MIME = {
  ".html": "text/html",
  ".js":   "text/javascript",
  ".mjs":  "text/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json",
  ".txt":  "text/plain",
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow = null;
let gateway = null;
let gatewayPort = null;
let shuttingDown = false;

// Single-instance: a second launch focuses the existing window instead of
// spinning up a second gateway against the same data dir (which the server's
// instanceLock would reject anyway).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  main();
}

// ── Update checks ─────────────────────────────────────────────────────────────
// Lightweight GitHub Releases check — no extra runtime dep, no packaging changes.
// Upgrade path: replace with electron-updater once the publish feed is live and
// the main-process bundle is extended to include npm runtime deps.
//
// Repo slug: override via DAIMON_GITHUB_REPO env var for forks/staging.
const GITHUB_REPO =
  process.env.DAIMON_GITHUB_REPO ?? "kat87ro/Daimon-OS";

async function checkForUpdates(manual = false) {
  if (!app.isPackaged && !manual) return; // skip in dev unless triggered manually
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github.v3+json" } },
    );
    if (!res.ok) return;
    const { tag_name, html_url } = await res.json();
    const latest = tag_name.replace(/^v/, "");
    const current = app.getVersion();
    if (latest !== current) {
      console.log(`[updater] new version available: ${latest} (running ${current})`);
      mainWindow?.webContents.send("update-available", { version: latest, url: html_url });
    }
  } catch {
    // Network unavailable — ignore silently
  }
}

// ── IPC handlers (renderer ↔ main) ───────────────────────────────────────────

function isTrustedIpc(event) {
  try {
    const frameUrl = new URL(event.senderFrame?.url ?? "");
    return event.senderFrame === event.sender.mainFrame &&
      frameUrl.protocol === "app:" && frameUrl.hostname === "daimon";
  } catch {
    return false;
  }
}

function trustedHandler(handler) {
  return (event, ...args) => {
    if (!isTrustedIpc(event)) throw new Error("untrusted IPC sender");
    return handler(...args);
  };
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function gatewayAdminRequest(pathname, init = {}) {
  if (gatewayPort == null) throw new Error("gateway is not ready");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${DAIMON_AUTH_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`http://127.0.0.1:${gatewayPort}${pathname}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`gateway returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

function validatedRun(runId, subjectHash) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) throw new Error("invalid run id");
  if (subjectHash !== undefined &&
      (typeof subjectHash !== "string" || !SUBJECT_HASH_PATTERN.test(subjectHash))) {
    throw new Error("invalid review subject hash");
  }
}

function validatedMcpServer(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("invalid MCP server");
  }
  const encoded = JSON.stringify(server);
  if (Buffer.byteLength(encoded, "utf8") > 128 * 1024) throw new Error("MCP server is too large");
  if (typeof server.id !== "string" || !UUID_PATTERN.test(server.id) ||
      typeof server.name !== "string" || !server.name.trim() || server.name.length > 512 ||
      (server.transport !== "stdio" && server.transport !== "http")) {
    throw new Error("invalid MCP server identity");
  }
  if (server.transport === "stdio") {
    const command = typeof server.command === "string" ? server.command.trim() : "";
    const args = server.args ?? [];
    const shellInterpreters = new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "wscript", "cscript", "osascript"]);
    if (!command || command.length > 512 || /[\u0000-\u001f\u007f]/.test(command) ||
        !Array.isArray(args) || args.length > 64 ||
        args.some((arg) => typeof arg !== "string" || arg.length > 512 || /[\u0000-\u001f\u007f]/.test(arg)) ||
        Buffer.byteLength(JSON.stringify({ command, args }), "utf8") > 4096 ||
        shellInterpreters.has(path.basename(command).toLowerCase())) {
      throw new Error("stdio MCP server must use a bounded direct executable and arguments");
    }
  }
  if (server.transport === "http") {
    const target = new URL(server.url);
    if (target.protocol !== "https:" &&
        !(target.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(target.hostname))) {
      throw new Error("HTTP MCP server must use HTTPS or loopback HTTP");
    }
  }
  return server;
}

function validatedImportPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid import payload");
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) throw new Error("import payload is too large");
  for (const key of ["skills", "agents", "mcpServers"]) {
    if (!Array.isArray(payload[key]) || payload[key].length > 256) throw new Error(`invalid ${key} import list`);
  }
  if (payload.providerId !== undefined &&
      (typeof payload.providerId !== "string" || !UUID_PATTERN.test(payload.providerId))) {
    throw new Error("invalid import provider id");
  }
  return payload;
}

function validatedGatewayRecord(candidate, label, maxBytes) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`invalid ${label}`);
  }
  const encoded = JSON.stringify(candidate);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(`${label} is too large`);
  return candidate;
}

function validatedLaunchRequest(candidate) {
  const value = validatedGatewayRecord(candidate, "launch request", 1024 * 1024);
  if (typeof value.channel !== "string" || !UUID_PATTERN.test(value.channel) || value.reqId !== value.channel ||
      (value.kind !== "agent" && value.kind !== "shell" && value.kind !== "chat") ||
      !Number.isInteger(value.cols) || value.cols < 1 || value.cols > 1000 ||
      !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 1000 ||
      (value.kind === "agent" && (typeof value.agentId !== "string" || !UUID_PATTERN.test(value.agentId))) ||
      (value.kind === "chat" && (typeof value.providerId !== "string" || !UUID_PATTERN.test(value.providerId))) ||
      (value.model !== undefined && (typeof value.model !== "string" || value.model.length < 1 || value.model.length > 256)) ||
      (value.kind !== "chat" && (value.providerId !== undefined || value.model !== undefined)) ||
      (value.kind === "chat" && (value.agentId !== undefined || value.projectId !== undefined ||
        value.cwd !== undefined || value.command !== undefined || value.taskPrompt !== undefined ||
        value.oneShot !== undefined || value.fusionDepth !== undefined || value.overrides !== undefined)) ||
      (value.projectId !== undefined && (typeof value.projectId !== "string" || !UUID_PATTERN.test(value.projectId))) ||
      (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length > 4096)) ||
      (value.command !== undefined && ![
        "gh auth login --hostname github.com --git-protocol https --web --clipboard",
        "gh auth switch --hostname github.com",
      ].includes(value.command)) ||
      (value.displayName !== undefined && (typeof value.displayName !== "string" || value.displayName.length > 256)) ||
      value.taskPrompt !== undefined) {
    throw new Error("invalid launch request");
  }
  let overrides;
  if (value.overrides !== undefined) {
    if (!value.overrides || typeof value.overrides !== "object" || Array.isArray(value.overrides) ||
        Object.keys(value.overrides).some((key) => key !== "model") ||
        typeof value.overrides.model !== "string" || value.overrides.model.length > 512) {
      throw new Error("invalid launch override");
    }
    overrides = { model: value.overrides.model };
  }
  return {
    reqId: value.channel,
    kind: value.kind,
    ...(value.agentId ? { agentId: value.agentId } : {}),
    ...(value.providerId ? { providerId: value.providerId } : {}),
    ...(value.model ? { model: value.model } : {}),
    channel: value.channel,
    cols: value.cols,
    rows: value.rows,
    ...(value.cwd ? { cwd: value.cwd } : {}),
    ...(value.command ? { command: value.command } : {}),
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.displayName ? { displayName: value.displayName } : {}),
    ...(overrides ? { overrides } : {}),
  };
}

async function confirmNative(options) {
  if (!mainWindow) throw new Error("desktop window is not available");
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["Cancel", options.acceptLabel],
    defaultId: 0,
    cancelId: 0,
    title: options.title,
    message: options.message,
    detail: options.detail,
  });
  return response === 1;
}

async function gatewayAdminJson(pathname) {
  return (await gatewayAdminRequest(pathname)).json();
}

async function nativeActionHeaders(action, subject) {
  const subjectHash = createHash("sha256").update(JSON.stringify(subject)).digest("hex");
  const response = await gatewayAdminRequest("/api/admin/native-action", {
    method: "POST",
    body: JSON.stringify({ action, subjectHash }),
  });
  const grant = await response.json();
  if (typeof grant.token !== "string" || grant.token.length < 32) {
    throw new Error("gateway did not issue a valid native action capability");
  }
  return { "x-daimon-native-action": grant.token };
}

function registerIpc() {
  ipcMain.on("renderer-bootstrap", (event) => {
    event.returnValue = isTrustedIpc(event)
      ? { port: gatewayPort, rendererToken: DAIMON_RENDERER_TOKEN }
      : { port: null, rendererToken: null };
  });
  // Renderer requests a manual update check (e.g. from the Help menu callback)
  ipcMain.handle("check-for-updates", trustedHandler(() => checkForUpdates(true)));

  ipcMain.handle("launch-session", trustedHandler(async (candidate) => {
    const launch = validatedLaunchRequest(candidate);
    const [agents, projects, providers] = await Promise.all([
      gatewayAdminJson("/api/agents"),
      gatewayAdminJson("/api/projects"),
      gatewayAdminJson("/api/providers"),
    ]);
    const agent = launch.agentId ? agents.find((item) => item.id === launch.agentId) : undefined;
    const project = launch.projectId ? projects.find((item) => item.id === launch.projectId) : undefined;
    const provider = launch.providerId
      ? providers.find((item) => item.id === launch.providerId)
      : undefined;
    if (launch.kind === "chat") {
      if (!provider || !provider.enabled || provider.mode !== "cli") {
        throw new Error("selected chat provider is unavailable");
      }
      if (provider.models.length > 0 && !launch.model) {
        throw new Error("select a provider-reported model");
      }
      if (launch.model && !provider.models.some((model) => model.id === launch.model)) {
        throw new Error("selected model is no longer in the provider catalog; refresh models");
      }
    }
    const approved = await confirmNative({
      acceptLabel: "Launch process",
      title: "Launch local process",
      message: `Launch ${agent?.name ?? provider?.name ?? launch.displayName ?? launch.kind} on this Mac?`,
      detail: [
        `Runtime: ${launch.kind === "shell" ? "interactive shell" : launch.kind === "chat" ? "ad-hoc provider chat" : "provider CLI"}`,
        launch.kind === "chat" ? `Provider: ${provider?.name}` : undefined,
        launch.kind === "chat" ? `Model: ${launch.model ?? "provider native default"}` : undefined,
        launch.kind !== "chat" ? `Project: ${project?.name ?? "scratch"}` : undefined,
        launch.kind !== "chat" ? `Working directory: ${launch.cwd ?? project?.path ?? "default user directory"}` : undefined,
        launch.command ? `Initial command: ${launch.command}` : undefined,
      ].filter(Boolean).join("\n"),
    });
    if (!approved) return { ok: false, canceled: true };
    const headers = await nativeActionHeaders("spawn", launch);
    const response = await gatewayAdminRequest("/api/admin/spawn", {
      method: "POST",
      headers,
      body: JSON.stringify(launch),
    });
    return { ok: true, canceled: false, session: await response.json() };
  }));

  ipcMain.handle("start-project", trustedHandler(async (projectId) => {
    if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) throw new Error("invalid project id");
    const [projects, teams, agents] = await Promise.all([
      gatewayAdminJson("/api/projects"),
      gatewayAdminJson("/api/teams"),
      gatewayAdminJson("/api/agents"),
    ]);
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("unknown project");
    const team = teams.find((item) => item.id === project.teamId);
    const lead = team?.supervisorAgentId
      ? agents.find((item) => item.id === team.supervisorAgentId)
      : undefined;
    const approved = await confirmNative({
      acceptLabel: "Start Lead and team",
      title: "Start project automation",
      message: `Start ${lead?.name ?? "the selected Lead"} for “${String(project.name).slice(0, 256)}”?`,
      detail: `Project: ${String(project.path).slice(0, 2048)}\nTeam: ${team?.name ?? "not configured"}\n\nThis grants the current Lead and team roster permission to launch their configured local provider CLIs until the Lead exits or the team changes.`,
    });
    if (!approved) return { ok: false, canceled: true };
    const headers = await nativeActionHeaders("start-project", {
      projectId,
      teamId: project.teamId ?? null,
      supervisorAgentId: team?.supervisorAgentId ?? null,
      memberAgentIds: [...(team?.memberAgentIds ?? [])].map(String).sort(),
    });
    const response = await gatewayAdminRequest(`/api/projects/${projectId}/start`, {
      method: "POST",
      headers,
      body: "{}",
    });
    return { ok: true, canceled: false, session: await response.json() };
  }));

  ipcMain.handle("configure-github-project", trustedHandler(async (projectId, repository) => {
    if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) throw new Error("invalid project id");
    if (typeof repository !== "string" || repository.length > 201 ||
        !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
        repository.includes("..")) {
      throw new Error("invalid github.com repository");
    }
    const projects = await gatewayAdminJson("/api/projects");
    const selected = projects.find((item) => item.id === projectId);
    if (!selected) throw new Error("unknown project");
    const project = selected.parentProjectId
      ? projects.find((item) => item.id === selected.parentProjectId)
      : selected;
    if (!project) throw new Error("project root is missing");
    const approved = await confirmNative({
      acceptLabel: "Link repository",
      title: "Link local project to GitHub",
      message: `Set the Git origin for “${String(project.name).slice(0, 256)}”?`,
      detail: [
        `Local repository: ${String(project.path).slice(0, 2048)}`,
        `GitHub repository: github.com/${repository}`,
        "",
        "Daimon will verify that your active GitHub account can access the repository, then add or replace only remote.origin.url. It will not create commits, push code, or change branches.",
      ].join("\n"),
    });
    if (!approved) return { ok: false, canceled: true };
    const headers = await nativeActionHeaders("configure-github", {
      projectId: project.id,
      repository,
    });
    const response = await gatewayAdminRequest(`/api/admin/projects/${project.id}/github`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repository }),
    });
    return { ok: true, canceled: false, result: await response.json() };
  }));

  ipcMain.handle("get-run-diff", trustedHandler(async (runId) => {
    validatedRun(runId);
    const approved = await confirmNative({
      acceptLabel: "Open captured diff",
      title: "Open agent evidence",
      message: "Open this run's captured source diff?",
      detail: `Run ${runId.slice(0, 8)}\n\nCaptured diffs may contain proprietary code or credentials. Only open evidence you intend to review.`,
    });
    if (!approved) return { ok: false, canceled: true };
    return {
      ok: true,
      canceled: false,
      diff: await (await gatewayAdminRequest(`/api/runs/${runId}/diff`)).text(),
    };
  }));

  ipcMain.handle("respond-to-attention", trustedHandler(async (attentionId, responseText) => {
    if (typeof attentionId !== "string" || !UUID_PATTERN.test(attentionId)) throw new Error("invalid attention id");
    if (typeof responseText !== "string" || !responseText.trim() || Buffer.byteLength(responseText, "utf8") > 64 * 1024) {
      throw new Error("invalid attention response");
    }
    const approved = await confirmNative({
      acceptLabel: "Send response",
      title: "Respond to agent",
      message: "Send this operator response to the active agent?",
      detail: `Attention ${attentionId.slice(0, 8)}\n\n${responseText.slice(0, 2048)}`,
    });
    if (!approved) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest(`/api/attention/${attentionId}/respond`, {
      method: "POST",
      body: JSON.stringify({ response: responseText }),
    });
    return { ok: true, canceled: false, result: await result.json() };
  }));

  ipcMain.handle("save-secret", trustedHandler(async (candidate) => {
    const payload = validatedGatewayRecord(candidate, "secret payload", 256 * 1024);
    const secret = validatedGatewayRecord(payload.secret, "secret", 64 * 1024);
    if (typeof secret.id !== "string" || !UUID_PATTERN.test(secret.id) ||
        typeof secret.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.key)) {
      throw new Error("invalid secret identity");
    }
    const approved = await confirmNative({
      acceptLabel: "Save credential",
      title: "Save credential",
      message: `Store or update credential “${secret.key}”?`,
      detail: "The value is encrypted at rest and may be granted to selected projects and agents. Verify the credential and scope before continuing.",
    });
    if (!approved) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest("/api/secrets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { ok: true, canceled: false, secret: await result.json() };
  }));

  ipcMain.handle("remove-secret", trustedHandler(async (id) => {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new Error("invalid secret id");
    const approved = await confirmNative({
      acceptLabel: "Remove credential",
      title: "Remove credential",
      message: "Remove this credential and all of its project and agent grants?",
      detail: `Credential ${id.slice(0, 8)}`,
    });
    if (!approved) return { ok: false, canceled: true };
    await gatewayAdminRequest(`/api/secrets/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true, canceled: false };
  }));

  ipcMain.handle("save-agent", trustedHandler(async (candidate) => {
    const agent = validatedGatewayRecord(candidate, "agent", 512 * 1024);
    if (typeof agent.id !== "string" || !UUID_PATTERN.test(agent.id)) throw new Error("invalid agent id");
    const approved = await confirmNative({
      acceptLabel: "Save agent authority",
      title: "Confirm agent execution authority",
      message: `Save runtime authority for “${String(agent.name).slice(0, 256)}”?`,
      detail: `Provider: ${String(agent.providerId).slice(0, 64)}\nIsolation: ${String(agent.isolation).slice(0, 64)}\nCredential grants: ${(agent.secretIds ?? []).length}\n\nThese settings control which executable, filesystem, MCP processes, and credentials the agent may use.`,
    });
    if (!approved) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest("/api/agents", { method: "POST", body: JSON.stringify(agent) });
    return { ok: true, canceled: false, agent: await result.json() };
  }));

  ipcMain.handle("save-project", trustedHandler(async (candidate) => {
    const project = validatedGatewayRecord(candidate, "project", 256 * 1024);
    if (typeof project.id !== "string" || !UUID_PATTERN.test(project.id) ||
        typeof project.path !== "string" || !project.path.trim()) throw new Error("invalid project");
    const approved = await confirmNative({
      acceptLabel: "Save project authority",
      title: "Confirm project authority",
      message: `Allow “${String(project.name).slice(0, 256)}” to use this filesystem, team, and credential scope?`,
      detail: `Path: ${project.path.slice(0, 2048)}\nTeam: ${String(project.teamId ?? "none").slice(0, 64)}\nCredential grants: ${(project.secretIds ?? []).length}`,
    });
    if (!approved) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest("/api/projects", { method: "POST", body: JSON.stringify(project) });
    return { ok: true, canceled: false, project: await result.json() };
  }));

  ipcMain.handle("approve-run", trustedHandler(async (runId, subjectHash) => {
    validatedRun(runId, subjectHash);
    if (!mainWindow) throw new Error("desktop window is not available");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Cancel", "Approve exact change"],
      defaultId: 0,
      cancelId: 0,
      title: "Approve agent change",
      message: "Approve the exact reviewed Git change?",
      detail: `Run ${runId.slice(0, 8)} · evidence ${subjectHash.slice(0, 12)}…\n\nOnly this content hash can be promoted.`,
    });
    if (response !== 1) return { ok: false, canceled: true };
    await gatewayAdminRequest(`/api/runs/${runId}/approve`, {
      method: "POST",
      body: JSON.stringify({ subjectHash }),
    });
    return { ok: true, canceled: false };
  }));

  ipcMain.handle("promote-run", trustedHandler(async (runId, subjectHash) => {
    validatedRun(runId, subjectHash);
    await gatewayAdminRequest(`/api/runs/${runId}/promote`, {
      method: "POST",
      body: JSON.stringify({ subjectHash }),
    });
    return { ok: true };
  }));

  ipcMain.handle("save-mcp-server", trustedHandler(async (candidate) => {
    const server = validatedMcpServer(candidate);
    const currentServers = await gatewayAdminJson("/api/mcp");
    if (server.isDefault && !currentServers.some((current) => current.id === server.id && current.isDefault)) {
      throw new Error("renderer-created MCP servers cannot become defaults automatically");
    }
    if (!mainWindow) throw new Error("desktop window is not available");
    const target = server.transport === "stdio"
      ? JSON.stringify({ command: server.command, args: server.args ?? [] }, null, 2)
      : server.url;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Trust MCP server"],
      defaultId: 0,
      cancelId: 0,
      title: "Trust MCP server",
      message: `Allow agents to launch “${server.name}”?`,
      detail: `${server.transport.toUpperCase()}\n${String(target)}\n\nTrusted MCP servers can execute tools with your local user privileges. Only approve software you recognize.`,
    });
    if (response !== 1) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest("/api/mcp", {
      method: "POST",
      body: JSON.stringify(server),
    });
    return { ok: true, canceled: false, server: await result.json() };
  }));

  ipcMain.handle("remove-mcp-server", trustedHandler(async (id) => {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new Error("invalid MCP server id");
    if (!mainWindow) throw new Error("desktop window is not available");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Cancel", "Remove MCP server"],
      defaultId: 0,
      cancelId: 0,
      title: "Remove MCP server",
      message: "Remove this trusted MCP server from Daimon OS?",
    });
    if (response !== 1) return { ok: false, canceled: true };
    await gatewayAdminRequest(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true, canceled: false };
  }));

  ipcMain.handle("apply-provider-import", trustedHandler(async (candidate) => {
    const payload = validatedImportPayload(candidate);
    if (!mainWindow) throw new Error("desktop window is not available");
    if ((payload.skills.length || payload.agents.length) && typeof payload.kind !== "string") {
      throw new Error("provider kind is required for file imports");
    }
    const scan = payload.kind
      ? await gatewayAdminJson(`/api/import/scan?kind=${encodeURIComponent(payload.kind)}`)
      : { skills: [], agents: [] };
    const allowedSkills = new Set(scan.skills.map((item) => `${item.name}\0${item.path}`));
    const allowedAgents = new Set(scan.agents.map((item) => `${item.name}\0${item.path}`));
    if (payload.skills.some((item) => !allowedSkills.has(`${item?.name}\0${item?.path}`)) ||
        payload.agents.some((item) => !allowedAgents.has(`${item?.name}\0${item?.path}`))) {
      throw new Error("selected import files no longer match a fresh provider-home scan");
    }
    const commands = payload.mcpServers
      .filter((server) => server?.transport === "stdio")
      .map((server) => `${server.name}: ${server.command ?? "missing command"}`)
      .slice(0, 20);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Import selected items"],
      defaultId: 0,
      cancelId: 0,
      title: "Import provider configuration",
      message: "Trust and import the selected provider configuration?",
      detail: [
        `${payload.skills.length} skills · ${payload.agents.length} agents · ${payload.mcpServers.length} MCP servers`,
        ...payload.skills.map((item) => `Skill: ${item.name}\n${item.path}`),
        ...payload.agents.map((item) => `Agent: ${item.name}\n${item.path}`),
        ...(commands.length ? ["Executable MCP servers:", ...commands] : []),
      ].join("\n\n"),
    });
    if (response !== 1) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest("/api/import/apply", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { ok: true, canceled: false, result: await result.json() };
  }));

  ipcMain.handle("sync-provider-import", trustedHandler(async (providerId) => {
    if (typeof providerId !== "string" || !UUID_PATTERN.test(providerId)) throw new Error("invalid provider id");
    if (!mainWindow) throw new Error("desktop window is not available");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Cancel", "Sync trusted CLI config"],
      defaultId: 0,
      cancelId: 0,
      title: "Sync provider configuration",
      message: "Import newly discovered agents, skills, and MCP servers from this CLI's user configuration?",
    });
    if (response !== 1) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest("/api/import/sync", {
      method: "POST",
      body: JSON.stringify({ providerId }),
    });
    return { ok: true, canceled: false, result: await result.json() };
  }));

  ipcMain.handle("clone-skill", trustedHandler(async (skillId, providerKinds) => {
    if (typeof skillId !== "string" || !UUID_PATTERN.test(skillId)) throw new Error("invalid skill id");
    if (!Array.isArray(providerKinds) || providerKinds.length > 1 ||
        providerKinds.some((kind) => kind !== "claude")) {
      throw new Error("invalid skill clone target");
    }
    if (!mainWindow) throw new Error("desktop window is not available");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Install skill"],
      defaultId: 0,
      cancelId: 0,
      title: "Install provider skill",
      message: "Install this instruction-bearing skill into your Claude CLI profile?",
      detail: "The skill will be written under ~/.claude/skills and may influence future Claude sessions. Review its content and install only instructions you trust.",
    });
    if (response !== 1) return { ok: false, canceled: true };
    const result = await gatewayAdminRequest(`/api/skills/${encodeURIComponent(skillId)}/clone`, {
      method: "POST",
      body: JSON.stringify({ providerKinds }),
    });
    return { ok: true, canceled: false, result: await result.json() };
  }));

  ipcMain.handle("factory-reset", trustedHandler(() => factoryReset()));
}

function startGateway() {
  return new Promise((resolve, reject) => {
    gateway = utilityProcess.fork(GATEWAY_ENTRY, [], {
      // run the TypeScript gateway under Electron's own Node (tsx registered by
      // the .mjs bootstrap), so node-pty is exercised against the Electron ABI
      // (the #1 packaging risk).
      stdio: "pipe",
      env: {
        ...process.env,
        DAIMON_PORT: "0", // 0 → OS picks a free port; we read it back below
        DAIMON_HOST: "127.0.0.1", // hard loopback — never inherit 0.0.0.0
        DAIMON_ALLOWED_ORIGINS: APP_ORIGIN,
        DAIMON_DESKTOP: "1",
        // writable state under userData (read-only app bundle in prod; also avoids
        // colliding with a dev `pnpm dev` gateway holding apps/server/data).
        DAIMON_DATA_DIR: path.join(app.getPath("userData"), "data"),
        DAIMON_AUTH_TOKEN,
        DAIMON_RENDERER_TOKEN,
        // Packaged-app MCP entry (bundled .mjs run with node). Spread so dev mode
        // (MCP_ENTRY undefined) leaves the var unset and lead.ts falls back to tsx.
        ...(MCP_ENTRY ? { DAIMON_MCP_ENTRY: MCP_ENTRY } : {}),
        // Electron's own executable, used (with ELECTRON_RUN_AS_NODE=1) to run the
        // bundled MCP server — so it doesn't depend on a `node` being on the GUI
        // app's minimal PATH. lead.ts reads this when writing .mcp.json.
        DAIMON_NODE_BIN: process.execPath,
        // Real PATH (login shell + common bin dirs) so the gateway can find the
        // provider CLIs (claude/gemini/codex) and node when launched from Finder.
        PATH: AGENT_PATH,
      },
    });

    const timer = setTimeout(() => reject(new Error("gateway did not report ready within 30s")), 30_000);

    gateway.stdout?.on("data", (d) => process.stdout.write(`[gateway] ${d}`));
    gateway.stderr?.on("data", (d) => process.stderr.write(`[gateway] ${d}`));
    gateway.on("message", (msg) => {
      if (msg && msg.type === "gateway-ready" && typeof msg.port === "number") {
        gatewayPort = msg.port;
        clearTimeout(timer);
        console.log(`[main] gateway ready on 127.0.0.1:${gatewayPort}`);
        resolve(gatewayPort);
      }
    });
    gateway.on("exit", (code) => {
      clearTimeout(timer);
      if (gatewayPort == null) reject(new Error(`gateway exited before ready (code ${code})`));
    });
  });
}

function registerAppProtocol() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    let filePath = path.resolve(WEB_OUT, `.${pathname}`);
    const relativePath = path.relative(WEB_OUT, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("forbidden", { status: 403 });
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(WEB_OUT, "index.html");
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return new Response(data, {
        headers: {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "content-security-policy": CSP,
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      });
    } catch {
      return new Response(`not found: ${pathname}`, { status: 404 });
    }
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0c0e11",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--daimon-port=${gatewayPort}`],
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void openAllowedExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url);
      if (target.protocol === "app:" && target.hostname === "daimon") return;
    } catch { /* deny malformed navigation */ }
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void openAllowedExternal(url);
  });
  mainWindow.webContents.on("console-message", (details) => {
    console.log(`[renderer:${details.level}] ${details.message}`);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[main] renderer finished loading");
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[main] renderer failed to load: ${code} ${desc} ${url}`);
  });
  await mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// "Reset to Factory…" menu action — confirm, then POST the gateway's reset
// endpoint (same code path as the in-app Danger Zone button). The gateway
// broadcasts config_changed, so the renderer reloads to a clean slate and the
// Setup Wizard re-opens. We POST rather than wipe the data dir so the live
// ConfigStore/Vault stay authoritative (no torn on-disk state).
async function factoryReset() {
  if (!mainWindow || gatewayPort == null) return { ok: false, canceled: true };
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["Cancel", "Reset everything"],
    defaultId: 0,
    cancelId: 0,
    title: "Reset to Factory",
    message: "Reset Daimon OS to a clean slate?",
    detail:
      "This wipes ALL providers, agents, teams, projects, skills, MCP servers, goals, schedules, and secrets. It cannot be undone.",
  });
  if (response !== 1) return { ok: false, canceled: true };
  try {
    await gatewayAdminRequest("/api/admin/reset", {
      method: "POST",
      body: "{}",
    });
    // config_changed broadcast already triggers a reload; reload as a fallback too.
    mainWindow.reload();
    return { ok: true, canceled: false };
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Reset failed",
      message: "Could not reset configuration.",
      detail: String(err),
    });
    return { ok: false, canceled: false, error: String(err) };
  }
}

async function main() {
  await app.whenReady();

  registerAppProtocol();
  registerIpc();

  try {
    await startGateway();
  } catch (err) {
    console.error("[main] gateway failed to start:", err);
    app.quit();
    return;
  }

  await createWindow();

  // Set native application menu after the first window so the menu callbacks
  // that reference mainWindow (e.g. checkForUpdates) work correctly.
  Menu.setApplicationMenu(buildMenu(checkForUpdates, factoryReset));

  // Kick off a background version check ~5s after launch (non-blocking).
  setTimeout(() => checkForUpdates(), 5_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

// Graceful quit: ask the gateway to run pm.shutdown() (SIGKILLs PTYs + docker
// rm -f containers) before we exit. We preventDefault on the first call, wait
// for a "gateway-closed" IPC ack (or the process to exit), hard-kill after 10s.
app.on("before-quit", (event) => {
  if (shuttingDown || !gateway) return;
  event.preventDefault();
  shuttingDown = true;

  const gw = gateway;
  gateway = null;

  const done = () => {
    clearTimeout(timer);
    app.quit(); // second call — shuttingDown=true, goes straight through
  };

  const timer = setTimeout(() => {
    console.log("[main] gateway close timeout — force killing");
    try { gw.kill(); } catch { /* already gone */ }
    done();
  }, 10_000);

  const onMsg = (msg) => {
    if (msg?.type === "gateway-closed") {
      gw.off("message", onMsg);
      done();
    }
  };
  gw.on("message", onMsg);
  gw.once("exit", done);

  try { gw.kill(); } catch { done(); }
});
