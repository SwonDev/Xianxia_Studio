# sidecars/

This folder is the staging area for the Python and Node sidecars that ship
with the installed app. It is **regenerated** by `pnpm sidecars:prepare` (run
automatically by `pnpm tauri:build`) and the contents (other than this README)
are gitignored.

On user install:

1. Tauri's bundler picks up everything under `sidecars/**/*` as resources.
2. NSIS / WiX places them at `<install-dir>/resources/sidecars/`.
3. On first launch, `sidecars::extract_bundled_sidecars()` (Rust) copies them
   to `<data_dir>/runtime/sidecar-{py,node}/` and writes a `.bundle-version`
   marker so subsequent launches skip the copy unless the app was updated.
4. The `Supervisor` resolves and spawns them like any user-installed runtime.
