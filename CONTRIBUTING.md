# Contributing to Orca

Thanks for helping improve Orca. This project is a Tauri desktop app with a React/TypeScript frontend and a Rust backend.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- For larger changes, open an issue first so the approach can be discussed before implementation.
- Keep pull requests focused. Separate unrelated refactors, bug fixes, and feature work.

## Development Setup

Follow the setup steps in [README.md](README.md). In short, you need:

- Node 20+
- pnpm 9+
- Rust stable with `rustfmt` and `clippy`
- Tauri platform dependencies for your operating system

Install dependencies and start the app:

```bash
pnpm install
pnpm tauri dev
```

## Quality Checks

Run the same checks CI runs before opening a pull request:

```bash
pnpm build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features --no-fail-fast
```

If you change Rust code, run `cargo fmt --all` from `src-tauri/` before committing.

## Pull Request Expectations

- Describe the problem and the solution clearly.
- Include screenshots or screen recordings for UI changes.
- Add or update tests when behavior changes.
- Update docs when commands, setup, release behavior, or user-facing workflows change.
- Call out any follow-up work or known limitations.

## Commit Style

Use short, imperative commit messages, for example:

```text
fix: preserve task status after refresh
docs: clarify release checklist
feat: add workspace reliability controls
```

## Reporting Bugs

Use the bug report issue form and include:

- Orca version or commit SHA
- Operating system and architecture
- Steps to reproduce
- Expected and actual behavior
- Logs, screenshots, or relevant console output

## Security Issues

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
