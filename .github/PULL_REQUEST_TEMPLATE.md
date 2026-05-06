## Summary

<!-- What changed and why? -->

## Screenshots or Recording

<!-- Required for UI changes. Drag images/video here or write "Not applicable". -->

## Testing

<!-- List the checks you ran. Include any checks you intentionally skipped and why. -->

- [ ] `pnpm build`
- [ ] `cargo fmt --all -- --check` from `src-tauri/`
- [ ] `cargo clippy --all-targets --all-features -- -D warnings` from `src-tauri/`
- [ ] `cargo test --all-features --no-fail-fast` from `src-tauri/`

## Checklist

- [ ] I kept the change focused and avoided unrelated refactors.
- [ ] I added or updated tests for behavior changes.
- [ ] I updated documentation for setup, commands, release flow, or user-facing behavior changes.
- [ ] I checked the app manually for UI or workflow changes.
- [ ] I called out follow-up work or known limitations.
