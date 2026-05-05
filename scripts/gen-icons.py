"""Generate Tauri icons from the master logo SVG.

Tries to rasterize `assets/logo/logo.svg` using cairosvg → Pillow.
If cairosvg isn't available, falls back to placeholder solid icons so the
Tauri build doesn't fail (developer can re-run after `pip install cairosvg`).

Outputs into apps/desktop/src-tauri/icons/:
  32x32.png · 128x128.png · 128x128@2x.png · icon.png · icon.ico · icon.icns
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SVG = ROOT / "assets" / "logo" / "logo.svg"
ICONS_DIR = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
ICONS_DIR.mkdir(parents=True, exist_ok=True)

GOLD = (201, 168, 76, 255)
DARK = (10, 10, 15, 255)


def try_rasterize(target_size: int) -> bytes | None:
    """Render the SVG to PNG bytes at target_size×target_size.

    Tries cairosvg first (cleanest output), falls back to svglib+reportlab
    (pure-python, no native deps), then to None.
    """
    # Path 1: cairosvg (best quality, needs libcairo)
    try:
        import cairosvg  # type: ignore
        return cairosvg.svg2png(
            url=str(SOURCE_SVG),
            output_width=target_size,
            output_height=target_size,
        )
    except (ImportError, OSError):
        pass

    # Path 2: svglib + reportlab (pure-python)
    try:
        from svglib.svglib import svg2rlg  # type: ignore
        from reportlab.graphics import renderPM  # type: ignore
        import io

        drawing = svg2rlg(str(SOURCE_SVG))
        if drawing is None:
            return None
        # Scale to target size
        orig_w = drawing.width or 1002
        scale = target_size / float(orig_w)
        drawing.width = drawing.width * scale
        drawing.height = drawing.height * scale
        drawing.scale(scale, scale)
        buf = io.BytesIO()
        renderPM.drawToFile(drawing, buf, fmt="PNG")
        return buf.getvalue()
    except Exception:
        pass

    return None


def fallback_png(size: int) -> bytes:
    """Solid Celestial Dark fallback when cairosvg isn't installed."""
    pixels = bytearray()
    cx = cy = size // 2
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            dx, dy = x - cx, y - cy
            r = (dx * dx + dy * dy) ** 0.5
            outer = size * 0.45
            inner = size * 0.30
            if r < inner:
                col = GOLD
            elif r < outer:
                col = DARK
            else:
                col = DARK
            pixels += bytes(col)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(pixels), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def make_png(size: int) -> bytes:
    rasterized = try_rasterize(size)
    if rasterized is not None:
        return rasterized
    return fallback_png(size)


def make_ico(sizes: list[int]) -> bytes:
    pngs = [(s, make_png(s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(pngs))
    entries = b""
    offset = 6 + 16 * len(pngs)
    body = b""
    for s, png in pngs:
        sz = s if s < 256 else 0
        entries += struct.pack("<BBBBHHII", sz, sz, 0, 0, 1, 32, len(png), offset)
        body += png
        offset += len(png)
    return header + entries + body


def write(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    rel = path.relative_to(ROOT)
    print(f"  {rel} ({len(data):,} bytes)")


def main() -> None:
    has_cairo = try_rasterize(8) is not None
    print(f"Source: {SOURCE_SVG.relative_to(ROOT)}")
    print(f"Renderer: {'cairosvg (real logo)' if has_cairo else 'fallback placeholder (install cairosvg for the real thing)'}")
    print()

    for size, name in [
        (32, "32x32.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (512, "icon.png"),
    ]:
        write(ICONS_DIR / name, make_png(size))

    write(ICONS_DIR / "icon.ico", make_ico([16, 32, 48, 64, 128, 256]))

    write(ICONS_DIR / "icon.icns", make_png(512))

    print()
    if has_cairo:
        print("Done. Icons generated from the real logo.")
    else:
        print("Done with placeholders.")
        print("To get the real logo: pip install cairosvg && python scripts/gen-icons.py")


if __name__ == "__main__":
    main()
