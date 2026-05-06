<!--
Gracias por tu PR. Rellena lo siguiente para acelerar la review.
-->

## Qué cambia

<!-- Una descripción breve del cambio. Si resuelve un issue, enlázalo con "Closes #123". -->

## Por qué

<!-- Motivación. Si es un fix, qué causaba el bug. Si es una feature, por qué encaja con el rumbo del proyecto. -->

## Tipo

- [ ] 🐛 Bug fix
- [ ] ✨ Nueva funcionalidad
- [ ] ♻️ Refactor (sin cambio de comportamiento)
- [ ] 📚 Documentación
- [ ] 🎨 Estilos / UI
- [ ] 🔧 Build / CI / config
- [ ] 🧪 Tests

## Filosofía AUTO

<!-- Si añades una integración o modelo nuevo, marca las 3 leyes -->

- [ ] Manifest entry en `installer/manifest.rs`
- [ ] `verify.rs` autodetect + nuevo campo en `StackSummary`
- [ ] `/<feature>/backend` endpoint Python (si aplica)
- [ ] Card en Settings → Componentes opcionales (si >100 MB)
- [ ] Toggle dinámico en Generator wizard (si impacta al pipeline)
- [ ] Pipeline phase wired con graceful skip si no instalado
- [ ] Spec Playwright en `tests/e2e/`
- [ ] `tauri-shim.ts` parity para browser-mode

## Verificación local

- [ ] `cargo check` sin warnings
- [ ] `pnpm typecheck` (`tsc -b`) ✓
- [ ] `pnpm lint` ✓ (0 warnings)
- [ ] Probado el flujo en `pnpm tauri:dev`
- [ ] Tests Playwright relevantes pasan

## Capturas / video

<!-- Si la UI cambia, adjunta capturas o un video corto. -->

## Notas para la review

<!-- Decisiones controvertidas, trade-offs, dudas. -->
