// Preload — runs in an isolated context with Node access, before the page loads.
// Exposes two surfaces to the renderer via contextBridge:
//   1. __DAIMON_PORT__ / __DAIMON_DESKTOP__  — gateway port + desktop flag
//   2. daimon.*                               — narrow native capabilities
// Keep this surface minimal; it is the trust seam.
const { contextBridge, ipcRenderer } = require("electron");

const bootstrap = ipcRenderer.sendSync("renderer-bootstrap");
const port = Number(bootstrap?.port);
const authToken = typeof bootstrap?.rendererToken === "string" ? bootstrap.rendererToken : "";

contextBridge.exposeInMainWorld("__DAIMON_PORT__", Number.isInteger(port) && port > 0 && port <= 65535 ? port : null);
contextBridge.exposeInMainWorld("__DAIMON_DESKTOP__", true);
contextBridge.exposeInMainWorld(
  "__DAIMON_AUTH_TOKEN__",
  /^[A-Za-z0-9_-]{43}$/.test(authToken) ? authToken : null,
);

contextBridge.exposeInMainWorld("daimon", {
  // Narrow privileged gateway capabilities. The renderer never receives the
  // admin bearer; human approval and destructive reset remain in Electron main.
  launchSession: (request) => ipcRenderer.invoke("launch-session", request),
  startProject: (projectId) => ipcRenderer.invoke("start-project", projectId),
  configureGitHubProject: (projectId, repository) => ipcRenderer.invoke("configure-github-project", projectId, repository),
  getRunDiff: (runId) => ipcRenderer.invoke("get-run-diff", runId),
  respondToAttention: (attentionId, response) => ipcRenderer.invoke("respond-to-attention", attentionId, response),
  saveSecret: (payload) => ipcRenderer.invoke("save-secret", payload),
  removeSecret: (id) => ipcRenderer.invoke("remove-secret", id),
  saveAgent: (agent) => ipcRenderer.invoke("save-agent", agent),
  saveProject: (project) => ipcRenderer.invoke("save-project", project),
  approveRun: (runId, subjectHash) => ipcRenderer.invoke("approve-run", runId, subjectHash),
  promoteRun: (runId, subjectHash) => ipcRenderer.invoke("promote-run", runId, subjectHash),
  saveMcpServer: (server) => ipcRenderer.invoke("save-mcp-server", server),
  removeMcpServer: (id) => ipcRenderer.invoke("remove-mcp-server", id),
  applyProviderImport: (payload) => ipcRenderer.invoke("apply-provider-import", payload),
  syncProviderImport: (providerId) => ipcRenderer.invoke("sync-provider-import", providerId),
  cloneSkill: (skillId, providerKinds) => ipcRenderer.invoke("clone-skill", skillId, providerKinds),
  factoryReset: () => ipcRenderer.invoke("factory-reset"),

  // Subscribe to update-available events (fired by the GitHub release check).
  // Returns an unsubscribe function.
  onUpdateAvailable: (cb) => {
    if (typeof cb !== "function") throw new TypeError("callback required");
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.off("update-available", handler);
  },

  // Trigger a manual update check (called by the native "Check for Updates" menu item).
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
});
