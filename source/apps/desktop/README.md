# Desktop shell

The Electron shell packages the Daimon OS gateway and static dashboard as a native desktop application.

```text
Electron main
├── utilityProcess -> bundled loopback gateway
├── app://daimon   -> static Next.js renderer
├── preload        -> minimal authenticated renderer bridge
└── extra resource -> project-scoped MCP adapter
```

Runtime data is written below Electron `userData`. No configuration, provider connection, model selection, MCP registration, agent, team, project, goal, or task is included in a fresh application package.

## Development

From `source/`:

```bash
corepack pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @daimon-os/desktop spike
```

`node-pty` must be built for Electron's ABI. The spike script performs the renderer build and native rebuild before launching Electron.

## Packaging

```bash
pnpm --filter @daimon-os/desktop dist:mac-universal  # app/Mac
pnpm --filter @daimon-os/desktop dist:win            # app/Windows
pnpm --filter @daimon-os/desktop dist:linux          # app/Linux
```

The gateway is bundled with esbuild. `node-pty` remains external and is unpacked from the ASAR so Electron can load the target-platform native binary. The packaging configuration excludes any host-built `node-pty/build` directory and relies on target prebuilds/rebuild output.

Unsigned or cross-built packages are evaluation artifacts. Public release requires target-platform signing, macOS notarization, checksums, and clean-machine install/launch/PTY validation. See [Deployment and packaging](../../docs/DEPLOYMENT.md).
