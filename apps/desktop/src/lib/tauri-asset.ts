/**
 * Cross-mode `convertFileSrc` wrapper.
 *
 * In Tauri prod the SDK's `convertFileSrc` rewrites a Windows path to the
 * `asset://` protocol the webview can serve. In browser/dev mode that
 * protocol doesn't exist, so we go through the Python sidecar's
 * `/diag/file?path=…` static-file endpoint. Same image / video URL ends
 * up in `<img src>` / `<video src>` either way, so the UI doesn't care.
 *
 * Wire one wrapper here and import it in routes/* instead of importing
 * directly from `@tauri-apps/api/core` — that import returns `undefined`
 * when the Tauri runtime isn't loaded and the page crashes (the v0.1.46
 * Library "Cannot read properties of undefined" bug).
 */

import { convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core';

const TAURI =
  typeof window !== 'undefined' &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    undefined;

const PY = 'http://127.0.0.1:8731';

export function convertFileSrc(path: string | null | undefined, protocol = 'asset'): string {
  if (!path) return '';
  if (TAURI) {
    try {
      return tauriConvertFileSrc(path, protocol);
    } catch {
      // fall through to browser fallback
    }
  }
  // Browser mode: route through the Python sidecar so the file is
  // served over HTTP with proper MIME (Range for video, etc.).
  return `${PY}/diag/file?path=${encodeURIComponent(path)}`;
}
