# Security policy

## Supported code

Daimon OS is pre-release. Security reports should identify the affected commit and operating system. Until a public release explicitly states otherwise, only the current source line is considered for fixes; self-built packages and forks may need to carry or rebuild a patch locally.

## Report a vulnerability privately

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, or social channel.

Use the repository's **Security** tab and choose **Report a vulnerability** to open a private GitHub Security Advisory. If private vulnerability reporting is not available, contact the repository owner through their platform account and ask for a private reporting channel. Do not include exploit details or secrets in that first message.

Include, where safe:

- the affected commit/version, operating system, and architecture;
- attack prerequisites and realistic impact;
- a minimal reproduction or proof of concept;
- whether provider credentials, workspace data, signing material, or local execution authority may be exposed;
- any coordinated-disclosure constraint.

No bug bounty or response-time commitment is implied unless a separate published program says so.

## Security boundary

Daimon OS can launch provider CLIs and other configured local processes with the current user's authority. Treat imported repositories, prompts, hooks, skills, MCP servers, dependencies, and generated changes as untrusted code.

The packaged desktop uses an authenticated loopback gateway and a sandboxed Electron renderer with a minimal preload bridge. Scheduler-dispatched Git work uses separate worktrees and exact-subject review controls, but this is not OS-level containment. A hostile process running as the same user may reach data outside its working directory.

Local audit and execution records support review and recovery; they are controlled by the local account and are not an independent tamper-proof or compliance archive. Never place production provider, release-signing, or deployment credentials in a development build.

For the current posture and distribution boundary, see [`source/docs/ARCHITECTURE.md`](source/docs/ARCHITECTURE.md) and [`source/docs/DEPLOYMENT.md`](source/docs/DEPLOYMENT.md).
