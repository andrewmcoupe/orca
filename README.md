# Orca

A Tauri + React + TypeScript desktop app.

## Development setup

### 1. Rust toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Restart your shell after installation so `cargo` and `rustc` are on `PATH`.

### 2. Node + pnpm

Node 20+ and pnpm 9+ are required. Any installation method works; for example via [Volta](https://volta.sh):

```bash
curl https://get.volta.sh | bash
volta install node@22 pnpm@9
```

### 3. Platform system dependencies

**macOS** — Xcode Command Line Tools:

```bash
xcode-select --install
```

**Linux (Ubuntu/Debian)**:

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libssl-dev build-essential curl wget file libxdo-dev
```

**Windows** — Microsoft Edge WebView2 (preinstalled on Windows 11) and Visual Studio Build Tools with the "Desktop development with C++" workload.

### 4. Run the app

```bash
pnpm install
pnpm tauri dev
```

The first `tauri dev` compiles the Rust side from scratch (3–10 minutes depending on the machine). Subsequent runs are incremental.

## Scripts

- `pnpm tauri dev` — launches the desktop app with hot reload (Vite + Rust).
- `pnpm dev` — frontend only, in a browser tab. Most features will not work since they require Tauri IPC.
- `pnpm build` — typecheck and build the frontend bundle.
- `pnpm tauri build` — produce a release-mode desktop bundle.

## Rust workspace

Backend code lives in `src-tauri/`. Useful commands (run from `src-tauri/`):

- `cargo test` — run the unit/integration tests.
- `cargo clippy --all-targets --all-features -- -D warnings` — lint.
- `cargo fmt --all` — format.

## Recommended IDE

[VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.
