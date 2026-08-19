# Deployment and packaging

Daimon OS is a local desktop application. There is no server deployment, product account, subscription backend, payment service, or hosted entitlement service.

## Output layout

```text
app/
├── Mac/       macOS Universal DMG
├── Linux/     Linux x86-64 AppImage
├── Windows/   Windows x86-64 NSIS installer
├── README.md
└── SHA256SUMS
```

## Prerequisites

- Node.js 22.12 or newer
- pnpm 9.15.9 through Corepack
- Git
- platform-native compiler toolchain required by `node-pty`
- Xcode command-line tools for macOS packaging

Install and validate from `source/`:

```bash
corepack pnpm install --frozen-lockfile
pnpm typecheck
```

## Build commands

Run each command on its target operating system. Each command builds the static renderer, bundles the gateway and MCP runtime, rebuilds the target-native terminal module, and invokes Electron Builder:

```bash
# macOS Universal: arm64 and x86_64
pnpm --filter @daimon-os/desktop dist:mac-universal

# Windows x86-64
pnpm --filter @daimon-os/desktop dist:win

# Linux x86-64 AppImage
pnpm --filter @daimon-os/desktop dist:linux
```

The commands write directly to `app/Mac`, `app/Windows`, and `app/Linux`.

## Signing and platform acceptance

### macOS

Release builds require a Developer ID Application certificate plus:

```text
CSC_LINK
CSC_KEY_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

Verify the final `.app` with `codesign`, Gatekeeper with `spctl`, and notarization with `xcrun stapler`. Audit every reachable executable, framework, dylib, helper, and native `.node` module for the advertised architectures.

### Windows

Release builds require an Authenticode certificate exposed to CI as `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. Validate the exact installer with `Get-AuthenticodeSignature`, then perform install, launch, PTY, update, and uninstall checks on Windows.

### Linux

Release builds require `LINUX_SIGNING_PRIVATE_KEY` and a matching `LINUX_SIGNING_KEY_FINGERPRINT`. The reviewed fingerprint in `apps/desktop/release/linux-signing-key.sha256` is the trust anchor. It must not remain `UNCONFIGURED` for a tagged public release.

Validate the AppImage on a supported Linux distribution, including launch, sandbox behavior, PTY creation, provider CLI discovery, and desktop integration.

## Release discipline

1. Start from reviewed source and an immutable lockfile.
2. Confirm no runtime `userData`, credentials, dependency folders, or expanded packages are included.
3. Build in the target-platform job.
4. Sign and validate the exact candidate bytes.
5. Record filename, size, SHA-256 digest, architecture, and signing identity.
6. Perform clean-machine installation and first-run validation.
7. Publish the same verified bytes; do not rebuild after approval.

Unsigned or cross-built files in `app/` are evaluation artifacts, not production release evidence.
