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

Backend code lives in `src-tauri/`. Run these from the `src-tauri/` directory:

- `cargo test` — run the unit/integration tests.
- `cargo clippy --all-targets --all-features -- -D warnings` — lint.
- `cargo fmt --all` — format the workspace in place.
- `cargo fmt --all -- --check` — verify formatting without writing (use in CI / pre-commit).
- `cargo check` — fast type-check without producing binaries.

## Releasing

Releases are built and signed by GitHub Actions (`.github/workflows/release.yml`) on tag push, and published as a **draft** release on GitHub. The currently configured matrix builds macOS Apple Silicon and Intel `.dmg`s; both are signed with the team's Developer ID Application certificate and notarized by Apple.

Auto-update is wired up via the Tauri updater plugin pointed at `releases/latest/download/latest.json` — once a release is published, already-installed copies of the app prompt the user to update on next launch.

### Cutting a new release

1. **Bump the version in three places** — they must all match (tag is the version with a leading `v`):
   - `package.json` → `"version": "0.1.3"`
   - `src-tauri/Cargo.toml` → `version = "0.1.3"`
   - `src-tauri/tauri.conf.json` → `"version": "0.1.3"`

   The Tauri updater compares the running app's version against the version in `latest.json` (which comes from `tauri.conf.json`), so a mismatch silently breaks auto-updates.

2. **Commit and push to `main`**:

   ```bash
   git commit -am "release: v0.1.3"
   git push origin main
   ```

3. **Tag and push the tag** — *this* is what triggers the workflow. Pushing to `main` alone does nothing.

   ```bash
   git tag v0.1.3
   git push origin v0.1.3
   ```

4. **Wait for the workflow to finish** (~15–20 min for both Mac arches). Track it under the Actions tab. On success it creates a draft release.

5. **Review the draft**: GitHub → Releases → click the "Drafts" tab. Confirm the assets are present:
   - `orca_<version>_aarch64.dmg` (Apple Silicon)
   - `orca_<version>_x64.dmg` (Intel)
   - `orca.app.tar.gz` + `orca.app.tar.gz.sig` (updater payloads — testers don't download these directly)
   - `latest.json` (the updater manifest)

   Edit the release notes in the **description field**: the auto-update prompt shown to users surfaces this body, so write something they'll actually want to read ("what's new", not just a commit list).

6. **Click "Publish release"**. At that point:
   - The release becomes visible at the public Releases URL.
   - The `latest.json` endpoint starts serving the new manifest.
   - On next launch, every installed copy of the previous version prompts the user to download/install/relaunch.

### If something goes wrong

- **Workflow fails on signing or notarization** — secrets are wrong or the cert expired. Check the `tauri-action` step output. The eight required secrets are listed in `.github/workflows/release.yml`.
- **Build succeeded but auto-update isn't picking it up** — confirm the version field in `tauri.conf.json` matches the tag, and that the release is published (not still in Draft). The updater endpoint only serves published releases.
- **Need to pull a release after publishing** — unpublish it from the Releases page (back to draft) *before* anyone updates. Once a user has installed it, you can't recall it; ship a fix-forward release with a higher version.

### Pre-flight check (local build)

To smoke-test the bundle before pushing a tag:

```bash
pnpm tauri build
```

Produces an unsigned local `.dmg` in `src-tauri/target/release/bundle/dmg/`. This won't be notarized but will catch most build-time errors faster than waiting on CI.

## Recommended IDE

[VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.
