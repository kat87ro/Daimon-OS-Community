# Daimon OS desktop packages

These are the community build artifacts for Daimon OS 0.2.1.

| Platform | Architecture | Installer |
| --- | --- | --- |
| macOS | Universal: Apple silicon (`arm64`) and Intel (`x86_64`) | [Daimon OS-0.2.1-universal.dmg](Mac/Daimon%20OS-0.2.1-universal.dmg) |
| Linux | `x86_64` | [Daimon OS-0.2.1.AppImage](Linux/Daimon%20OS-0.2.1.AppImage) |
| Windows | `x86_64` | [Daimon OS Setup 0.2.1.exe](Windows/Daimon%20OS%20Setup%200.2.1.exe) |

Verify an installer from this directory:

```sh
shasum -a 256 -c SHA256SUMS
```

## Release status

- The macOS DMG passed checksum verification. Its application and Electron runtime are Universal binaries. A fresh-profile launch confirmed that providers, agents, teams, projects, tasks, goals, skills, MCP servers, and schedules all start empty, and the packaged terminal module completed a real shell/PTY smoke test.
- The Windows application payload and native terminal dependency were inspected as `x86_64`. The installer was cross-built on macOS and was not executed on Windows.
- The Linux application and native terminal dependency were inspected as `x86_64`. Its packaged Electron runtime loaded `node-pty` and completed a real shell/PTY smoke test inside a Linux/x64 container. The desktop UI was not exercised on a native Linux workstation.
- These community artifacts are unsigned. The macOS application is not notarized, and the Windows installer has no Authenticode signature. Treat them as pre-release builds until platform signing and native-OS smoke tests are complete.

Build instructions are in [source/README.md](../source/README.md) and [source/docs/DEPLOYMENT.md](../source/docs/DEPLOYMENT.md).
