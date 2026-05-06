# Contribuir a Xianxia Studio

Gracias por interesarte en el proyecto. Antes de abrir un PR, ten en cuenta lo siguiente.

## Antes de empezar

- Para cambios pequeños (typos, fixes triviales) → abre un PR directamente.
- Para features nuevas, refactors grandes o cambios de arquitectura → abre primero un issue describiendo qué quieres hacer y por qué. Evita escribir código que no encaje con el rumbo del proyecto.

## Filosofía AUTO

Toda feature nueva debe cumplir las **3 leyes Auto**:

1. **Autoinstalable**: cero comandos en terminal por parte del usuario. Las dependencias entran al manifest del installer (`apps/desktop/src-tauri/src/installer/manifest.rs`) y se instalan desde Ajustes con un clic.
2. **Autodetectable**: `verify_stack` detecta por reflexión qué hay instalado (puerto, paquete Python, modelo HF, custom node ComfyUI). La UI se adapta dinámicamente al backend disponible.
3. **Autoconfigurable**: defaults sensatos sin que el usuario toque nada. Tier de hardware → modelo apropiado, idioma del sistema → voces filtradas, vertical/horizontal → resolución nativa.

Checklist al añadir una feature/integración:

- [ ] Manifest entry en `installer/manifest.rs` (`id`, `label`, `size_bytes`, `kind`, `required: false` si opcional)
- [ ] `verify.rs` autodetect + nuevo campo en `StackSummary`
- [ ] `/<feature>/backend` endpoint en el sidecar Python que reporta `{installed: bool, ...}`
- [ ] Card en Settings → Componentes opcionales (si pesa >100 MB o requiere build)
- [ ] Toggle dinámico en Generator si impacta al pipeline
- [ ] Pipeline phase wired con graceful skip si el backend no está instalado
- [ ] Spec Playwright en `tests/e2e/`
- [ ] `tauri-shim.ts` parity para que los specs corran en browser-mode

Si una feature no cumple las 3 leyes, no se mergea.

## Setup local

```bash
git clone https://github.com/SwonDev/Xianxia_Studio.git
cd Xianxia_Studio
pnpm install
pnpm tauri:dev
```

## Flujo de PR

1. **Branch**: parte de `main` y nombra la rama `feat/<corto>`, `fix/<corto>` o `docs/<corto>`.
2. **Commits**: usa el estilo del proyecto: `feat(area): mensaje`, `fix(area): mensaje`, `chore: ...`, `docs: ...`, `test: ...`. Un commit limpio explica el "por qué", no el "qué".
3. **Tests**: si añades una ruta backend o un componente UI nuevo, añade un spec Playwright en `tests/e2e/`. Los specs deben pasar en `pnpm playwright test` antes de mergear.
4. **Lint y typecheck**: el repo exige cero warnings.
   ```bash
   cd apps/desktop
   pnpm typecheck       # tsc -b
   pnpm lint            # eslint, --max-warnings 0
   cd src-tauri && cargo check
   ```
5. **PR**: rellena la descripción con qué cambia y por qué. Enlaza el issue relacionado si aplica.

## Estilo de código

- **TypeScript**: strict mode siempre. Evita `any` salvo en payloads IPC/JSON externos. Imports ordenados (auto vía editor).
- **React**: componentes funcionales, hooks con `use*` prefix, `export function` para componentes públicos. Animaciones con `motion`/`framer-motion`.
- **Tailwind**: usa los tokens del DESIGN.md (`obsidian` `gold` `jade` `paper` `crimson`). Nada de hex sueltos en JSX.
- **shadcn/ui**: instala componentes con `npx shadcn@latest add <componente>` antes de implementar UI desde cero.
- **Rust**: `cargo fmt` + `cargo clippy`. Sin `#![allow(dead_code)]` global; si una API es legítimamente futura, anota la función concreta con `#[allow(dead_code)] // razón futura`.
- **Python**: type hints donde sea posible, `async def` para I/O, `asyncio.run_in_executor` para trabajo bloqueante.

## Diseño visual

El proyecto consume `DESIGN.md` (formato Google Labs) como fuente de verdad de tokens. No improvises colores, radios ni tipografías. Si necesitas un token nuevo, añádelo a `DESIGN.md` y al `globals.css`.

## Reportar bugs

Abre un issue con plantilla "Bug report". Incluye:
- Versión de la app (Ajustes → Actualizaciones)
- Sistema operativo y versión
- GPU y VRAM
- Pasos exactos para reproducir
- Logs relevantes (Ajustes → Servicios → Ver logs)

## Código de conducta

Sé respetuoso. No toleramos hostilidad, ataques personales ni harassment. Discrepar técnicamente está bien y se hace con argumentos, no con descalificaciones.

## Licencia de tus contribuciones

Al enviar un PR aceptas que tu contribución se publique bajo la misma [Apache License 2.0](LICENSE) que el resto del repositorio.
