# Política de seguridad

## Reportar una vulnerabilidad

Si encuentras una vulnerabilidad en Xianxia Studio (escalada de privilegios, ejecución arbitraria, exfiltración de datos del usuario, manipulación del updater, etc.), **no abras un issue público**.

Reporta el hallazgo de forma privada usando una de estas vías:

1. **GitHub Security Advisories** (preferido): ve a la pestaña [Security](https://github.com/SwonDev/Xianxia_Studio/security) del repo y pulsa "Report a vulnerability". Es privado y queda registrado.
2. **Email** al maintainer indicado en el perfil de GitHub del repo.

Incluye en el reporte:

- Versión exacta de la app afectada (de la pantalla de Ajustes → Actualizaciones).
- Sistema operativo y arquitectura.
- Reproducción mínima paso a paso.
- Impacto observado y peor caso plausible.
- Cualquier mitigación que hayas identificado.

## Tiempos de respuesta

- **Acuse de recibo**: 72 horas hábiles.
- **Triage inicial** (severidad + plan): 7 días.
- **Parche y release**: depende de la severidad. Críticas → release out-of-band.

## Modelo de amenazas resumido

Xianxia Studio es una app **100 % local**. No envía datos del usuario a servidores externos salvo:

- **YouTube Data API** cuando el usuario sube un vídeo (OAuth con sus propias credenciales, almacenadas en el keyring del SO).
- **GitHub Releases** para comprobar actualizaciones (descarga del manifest `latest.json` y del bundle firmado).

Vectores que nos importan especialmente:

- **Updater**: el bundle se verifica contra una clave pública minisign embebida en la app. Una clave privada filtrada o un endpoint comprometido permitiría push de un binario malicioso. Cualquier debilidad en este flujo es **crítica**.
- **OAuth YouTube**: tokens almacenados en el keyring del SO mediante `keyring-rs`. Bypass del keyring o leak de tokens en logs es **crítico**.
- **Sidecars locales** (Python/Node/ComfyUI/Ollama): escuchan en `127.0.0.1`. Si un proceso local del mismo usuario puede invocarlos sin restricción y eso permite escalada o DoS, es **alto**.
- **CSP de la WebView**: cualquier inyección que rompa el CSP definido en `tauri.conf.json` es **alto**.

## Lo que **no** consideramos vulnerabilidad

- Contenido generado por los modelos de IA (alucinaciones, sesgos, contenido inapropiado): es responsabilidad del usuario revisar antes de publicar. Usa los filtros y la variante segura del LLM disponibles en Ajustes.
- Aviso "Editor desconocido" de SmartScreen: la app firma con clave de updater (gratis), no con certificado Authenticode comercial. Es esperado y no constituye vulnerabilidad.
- Componentes opcionales que no instalas y no usas.

## Disclosure

Una vez parcheada la vulnerabilidad, publicaremos un GitHub Security Advisory con CVE si aplica. Si quieres que se reconozca tu hallazgo con un crédito, indícalo en el reporte; si prefieres anonimato, también lo respetamos.

Gracias por mantener Xianxia Studio seguro.
