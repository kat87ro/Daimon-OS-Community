# Contributing to Daimon OS

Thank you for improving Daimon OS. Contributions should strengthen a local-first, reviewable control plane without overstating product or security guarantees.

## Before you start

- Search existing issues before opening a new one.
- For a substantial feature or architectural change, open an issue first and describe the problem, trust-boundary impact, alternatives, and migration cost.
- Never include provider tokens, repository secrets, personal paths, production identifiers, transcripts, or customer data in an issue, fixture, screenshot, or commit.
- Security vulnerabilities belong in the private process described in [SECURITY.md](SECURITY.md), not in a public issue.

## Development setup

Use Node.js 22.12 or newer and pnpm 9.15.9:

```bash
cd source
corepack pnpm install --frozen-lockfile
pnpm typecheck
```

Run the desktop development spike with:

```bash
pnpm --filter @daimon-os/desktop spike
```

Provider CLIs are external dependencies. Use non-production accounts or local runtimes where possible and redact their output before sharing it.

## Pull requests

Keep each pull request focused and explain:

1. the user or operator problem;
2. the chosen design and rejected alternatives;
3. security, privacy, persistence, and recovery consequences;
4. typecheck, build, and manual evidence;
5. documentation or claim changes.

Document how the change was validated. Preserve strict local gateway authentication, project-path validation, scoped credentials, worktree evidence, and human approval boundaries. Do not turn a successful agent run into an implicit commit, push, release, deployment, payment, or external message.

Use the canonical **Daimon OS** name. Do not redraw the logo or fabricate screenshots, metrics, provider support, platform support, or hosted capabilities. Brand use is governed by [TRADEMARKS.md](TRADEMARKS.md).

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](LICENSE).
