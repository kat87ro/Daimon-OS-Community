// Native application menu for Daimon OS.
// Built once after the first window is created; call buildMenu() and set it.
const { Menu, app, BrowserWindow, shell } = require("electron");

function buildMenu(checkForUpdates, onFactoryReset) {
  const isMac = process.platform === "darwin";

  const template = [
    // ── macOS application menu ─────────────────────────────────────────────────
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Check for Updates…",
                click: () => checkForUpdates(true),
              },
              {
                label: "Reset to Factory…",
                click: () => onFactoryReset && onFactoryReset(),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),

    // ── File (Windows / Linux) ─────────────────────────────────────────────────
    ...(!isMac
      ? [
          {
            label: "File",
            submenu: [
              {
                label: "Check for Updates…",
                click: () => checkForUpdates(true),
              },
              {
                label: "Reset to Factory…",
                click: () => onFactoryReset && onFactoryReset(),
              },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),

    // ── Edit ───────────────────────────────────────────────────────────────────
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ],
    },

    // ── View ───────────────────────────────────────────────────────────────────
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    // ── Window ─────────────────────────────────────────────────────────────────
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }, { type: "separator" }]
          : [{ type: "separator" }]),
        {
          label: "Daimon OS",
          click: () => {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) { win.show(); win.focus(); }
          },
        },
      ],
    },

    // ── Help ───────────────────────────────────────────────────────────────────
    {
      role: "help",
      submenu: [
        {
          label: "Report an Issue",
          click: () =>
            shell.openExternal(
              "https://github.com/kat87ro/Daimon-OS/issues/new/choose",
            ),
        },
        { type: "separator" },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
