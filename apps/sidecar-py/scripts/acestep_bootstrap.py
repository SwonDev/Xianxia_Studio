"""ACE-Step v1.5 venv auto-bootstrap — runs in the BACKGROUND at sidecar
boot. No Settings toggle, no manual wizard component: ACE-Step is the
PRINCIPAL music generator and must self-install with zero user action
(project rule: everything auto-detectable / auto-installable /
auto-configurable).

Idempotent. Creates an ISOLATED venv at `runtime/acestep-venv` +
clones `ACE-Step-1.5@v0.1.7` to `runtime/acestep-repo`, then installs
torch 2.7.1+cu128 + nano-vllm (local editable) + the repo. Isolated
because v0.1.7 pins torch 2.7.1+cu128 which would shred the main
sidecar's torch 2.5.1+cu121. Same strategy as DepthFlow.

While this runs (first launch, ~10-25 min on a fresh machine) the music
phase uses MusicGen → library. Once the venv is ready a later run uses
ACE-Step automatically. NEVER blocks the pipeline: any failure just
leaves the fallback chain in place and is retried next boot.

Invoked from `server.py` lifespan in a daemon thread. Safe to call
repeatedly: it no-ops fast when the venv is already healthy.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

_REPO_URL = "https://github.com/ace-step/ACE-Step-1.5.git"
_REPO_TAG = "v0.1.7"
_LOCK = threading.Lock()
_DONE = False


def _runtime_dir() -> Path:
    base = os.environ.get("XIANXIA_DATA_DIR")
    if base:
        return Path(base) / "runtime"
    return Path(os.environ.get("APPDATA", "")) / "xianxia" / "XianxiaStudio" / "data" / "runtime"


def _venv_python(venv_dir: Path) -> Path:
    win = venv_dir / "Scripts" / "python.exe"
    return win if os.name == "nt" else (venv_dir / "bin" / "python")


def _log(msg: str, **kw) -> None:
    try:
        from xianxia_ai.logging_utils import log_event  # type: ignore
        log_event("info", "acestep_bootstrap", step=msg, **kw)
    except Exception:
        print(f"[acestep_bootstrap] {msg} {kw}", flush=True)


def is_ready() -> bool:
    rt = _runtime_dir()
    venv_py = _venv_python(rt / "acestep-venv")
    repo = rt / "acestep-repo" / "acestep"
    if not (venv_py.is_file() and repo.is_dir()):
        return False
    try:
        r = subprocess.run(
            [str(venv_py), "-c", "import acestep, sys; sys.exit(0)"],
            cwd=str(rt / "acestep-repo"),
            capture_output=True, timeout=120,
        )
        return r.returncode == 0
    except Exception:
        return False


def _run(args: list[str], cwd: str | None = None, timeout: int = 3600) -> tuple[bool, str]:
    try:
        p = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
        if p.returncode != 0:
            return False, (p.stderr or p.stdout or "")[-600:]
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:400]


def _bootstrap() -> None:
    global _DONE
    rt = _runtime_dir()
    rt.mkdir(parents=True, exist_ok=True)
    venv_dir = rt / "acestep-venv"
    repo_dir = rt / "acestep-repo"
    venv_py = _venv_python(venv_dir)

    if is_ready():
        _log("already_ready")
        _DONE = True
        return

    # ── venv (base = the running embedded runtime python) ──────────────
    if not venv_py.is_file():
        _log("creating_venv")
        ok, err = _run([sys.executable, "-m", "venv", str(venv_dir)], timeout=600)
        if not ok or not venv_py.is_file():
            _log("venv_create_failed", error=err)
            return
    _run([str(venv_py), "-m", "pip", "install", "--upgrade", "--quiet",
          "pip", "wheel", "setuptools"], timeout=600)

    # ── torch 2.7.1 + CUDA 12.8 (the exact pin ACE-Step-1.5 v0.1.7
    #   needs; isolated so it never touches the sidecar's 2.5.1+cu121).
    _log("installing_torch_cu128")
    ok, err = _run([
        str(venv_py), "-m", "pip", "install", "--quiet",
        "torch==2.7.1", "torchaudio==2.7.1",
        "--index-url", "https://download.pytorch.org/whl/cu128",
    ], timeout=3600)
    if not ok:
        _log("torch_install_failed", error=err)
        return

    # ── clone the repo at the pinned tag ───────────────────────────────
    if not (repo_dir / "acestep").is_dir():
        _log("cloning_repo")
        try:
            if repo_dir.exists():
                import shutil
                shutil.rmtree(repo_dir, ignore_errors=True)
        except Exception:
            pass
        ok, err = _run([
            "git", "clone", "--depth", "1", "--branch", _REPO_TAG,
            _REPO_URL, str(repo_dir),
        ], timeout=1200)
        if not ok or not (repo_dir / "acestep").is_dir():
            _log("clone_failed", error=err)
            return

    # ── nano-vllm (local editable) + repo deps + repo (editable,
    #   --no-deps so pip can't move the torch we just pinned).
    nano = repo_dir / "acestep" / "third_parts" / "nano-vllm"
    if nano.is_dir():
        _log("installing_nano_vllm")
        ok, err = _run([str(venv_py), "-m", "pip", "install", "--quiet",
                        "-e", str(nano)], timeout=1200)
        if not ok:
            _log("nano_vllm_failed", error=err)
            return
    req = repo_dir / "requirements.txt"
    if req.is_file():
        _log("installing_repo_requirements")
        _run([str(venv_py), "-m", "pip", "install", "--quiet",
              "-r", str(req)], cwd=str(repo_dir), timeout=3600)
    _log("installing_acestep_pkg")
    ok, err = _run([str(venv_py), "-m", "pip", "install", "--quiet",
                    "--no-deps", "-e", "."], cwd=str(repo_dir), timeout=1200)
    if not ok:
        _log("pkg_install_failed", error=err)
        return

    if is_ready():
        _log("ready")
        _DONE = True
    else:
        _log("install_finished_but_import_failed")


def ensure_async() -> None:
    """Kick the bootstrap in a daemon thread. No-ops if already running
    or done. Safe to call from server.py lifespan on every boot."""
    global _DONE
    if _DONE or is_ready():
        _DONE = True
        return
    if not _LOCK.acquire(blocking=False):
        return  # a bootstrap thread is already running

    def _worker() -> None:
        try:
            _bootstrap()
        finally:
            try:
                _LOCK.release()
            except Exception:
                pass

    threading.Thread(target=_worker, daemon=True).start()


if __name__ == "__main__":
    # Allow a synchronous run for manual/installer use.
    _bootstrap()
    sys.exit(0 if is_ready() else 1)
