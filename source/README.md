# Daimon OS source

This folder contains the complete application source:

```text
apps/desktop   Electron lifecycle, trusted bridge, and native packaging
apps/server    authenticated loopback gateway and orchestration runtime
apps/web       static Next.js desktop renderer
packages/mcp   project-scoped Lead/worker MCP adapter
packages/shared shared schemas and domain types
docs/          architecture, packaging, and end-to-end user guide
```

## Development

```bash
corepack pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @daimon-os/desktop spike
```

The spike rebuilds `node-pty` for Electron, builds the renderer, and starts the desktop application. Provider CLIs are external dependencies and must be installed and authenticated separately.

## Packaging

```bash
pnpm --filter @daimon-os/desktop dist:mac-universal
pnpm --filter @daimon-os/desktop dist:win
pnpm --filter @daimon-os/desktop dist:linux
```

Outputs are written to the repository-level `app/` platform folders. See [Deployment and packaging](docs/DEPLOYMENT.md).
