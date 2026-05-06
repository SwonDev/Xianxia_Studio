# Cómo lanzar una nueva release

Versionado: solo bumps PATCH (`0.1.0` → `0.1.1` → `0.1.2`…).

## Flujo estándar (5 minutos)

```bash
# 1. Asegurar que main está limpio y al día
git checkout main && git pull origin main && git status

# 2. Bumpear versión en los 4 ficheros sincronizados
pnpm version:bump
# → 0.1.1 → 0.1.2 (auto patch). Para versión explícita: pnpm version:bump 0.2.0

# 3. Editar CHANGELOG.md — mover lo de [Unreleased] a la nueva versión

# 4. Commit + tag + push
git add -u
git commit -m "release: v0.1.2"
git tag v0.1.2
git push origin main --follow-tags
```

El push del tag dispara el workflow `Release` (`.github/workflows/release.yml`):

1. **Checkout** del tag.
2. **Setup** pnpm 10 + Node 22 + Rust stable + caché de `target/`.
3. **`pnpm install --frozen-lockfile`**.
4. **`pnpm branding`** — regenera iconos OS + BMPs del installer
   desde el logo SVG master.
5. **`tauri-apps/tauri-action@v0`** — compila el bundle NSIS .exe + MSI,
   firma con la clave del updater (`TAURI_SIGNING_PRIVATE_KEY` de
   secrets) y crea un **draft release** con los assets adjuntos.
6. **`includeUpdaterJson: true`** — sube el `latest.json` que
   consume el plugin updater de la app.

Tarda ~25 minutos en `windows-latest` (cold cache la primera vez).

## Tras el workflow

1. Abre la release en GitHub: la verás como **draft**.
2. Revisa que están los 3 assets:
   - `Xianxia_Studio_X.Y.Z_x64-setup.exe` (NSIS)
   - `Xianxia_Studio_X.Y.Z_x64_en-US.msi` (WiX)
   - `latest.json` (manifiesto del updater)
3. Edita la descripción si quieres mejorar el changelog.
4. **Publish release** — al publicar, el updater empieza a ofrecer
   la actualización a los clientes existentes.

## Disparo manual sin tag

Si necesitas re-correr el build de un tag existente o hacer un dry
run sin commitear:

1. Ve a Actions → Release → **Run workflow**.
2. Mete el tag (ej. `v0.1.1`).
3. Pulsa **Run workflow**.

## Secrets necesarios

| Secret | Origen | Cuándo |
|---|---|---|
| `GITHUB_TOKEN` | Auto | Siempre disponible |
| `TAURI_SIGNING_PRIVATE_KEY` | `pnpm tauri signer generate` | Una vez (Fase 3) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Pass elegido al generar | Una vez |

Sin la signing key se compila igual y se sube como draft, pero el
updater plugin de la app **no aceptará** la actualización (rechaza
bundles sin firma válida).

## Branding del installer

Si cambias el logo (`assets/logo/logo.svg`) o la paleta:

```bash
pnpm branding   # regenera iconos OS + BMPs del installer
```

Revisa visualmente las previews en `assets/installer/*.preview.png`
(gitignored, regen al vuelo) antes de commitear los `.bmp`.

## Hotfix sobre una release publicada

```bash
git checkout v0.1.1
git checkout -b hotfix/0.1.2
# ... fix ...
git commit -m "fix: descripción"
git checkout main && git merge hotfix/0.1.2
pnpm version:bump
# ... actualizar CHANGELOG ...
git tag v0.1.2 && git push origin main --follow-tags
```
