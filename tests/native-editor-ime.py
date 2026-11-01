#!/usr/bin/env python3
"""IME composition smoke test for Folio.

This is deliberately separate from `native-editor-keyboard.py`: it needs an
input method installed (fcitx5 + an engine) and a private session, so it is not
part of the default gate. Run it with `tests/native-editor-ime.sh`.

It starts fcitx5 with an isolated `XDG_CONFIG_HOME` (never touching the user's
real fcitx profile), launches the app with the GTK input-module bridge, types
romaji through the input method, commits the conversion, saves, and compares
the bytes on disk.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

PROFILE = """[Groups/0]
Name=Default
Default Layout=us
DefaultIM=mozc

[Groups/0/Items/0]
Name=keyboard-us
Layout=

[Groups/0/Items/1]
Name=mozc
Layout=

[GroupOrder]
0=Default
"""


def load_helpers():
    spec = importlib.util.spec_from_file_location("native_keyboard", HERE / "native-editor-keyboard.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_for_window(x11, pid: int, timeout: float = 20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        windows = x11.find_app_windows(pid, True) or x11.find_app_windows(pid, False)
        if windows:
            return max(windows, key=lambda window: (x11.attributes(window).width if x11.attributes(window) else 0))
        time.sleep(0.2)
    raise SystemExit("FAIL: the Folio window never appeared")


def main() -> int:
    binary = REPO / "target" / "debug" / "folio"
    if not binary.exists():
        print(f"FAIL: {binary} is missing; run `cargo build` first", file=sys.stderr)
        return 2

    nk = load_helpers()
    scratch_dir = Path(tempfile.mkdtemp(prefix="folio-ime-"))
    scratch = scratch_dir / "ime.md"
    scratch.write_text("# IME\n\nBefore. \n")

    config_home = scratch_dir / "config"
    (config_home / "fcitx5").mkdir(parents=True)
    (config_home / "fcitx5" / "profile").write_text(PROFILE)

    env = os.environ.copy()
    env.pop("FOLIO_NATIVE_PROBE", None)
    env["GDK_BACKEND"] = "x11"
    env["GTK_IM_MODULE"] = "fcitx"
    env["QT_IM_MODULE"] = "fcitx"
    env["XMODIFIERS"] = "@im=fcitx"
    env["XDG_CONFIG_HOME"] = str(config_home)

    im = subprocess.Popen(["fcitx5", "-d"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    app = subprocess.Popen([str(binary), str(scratch)], cwd=str(REPO), env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    x11 = None
    try:
        x11 = nk.X11()
        keyboard = nk.Keyboard(x11)
        window = wait_for_window(x11, app.pid)
        x11.focus(window)
        time.sleep(1.0)

        # Activate the input method, then compose romaji. mozc converts
        # "nihon" -> 日本 on the first space and commits with Return.
        subprocess.run(["fcitx5-remote", "-o"], env=env, check=False)
        time.sleep(0.4)
        keyboard.type_text("nihon")
        time.sleep(0.6)
        keyboard.type_text(" ")
        time.sleep(0.8)
        keyboard.chord("Return")
        time.sleep(0.5)

        keyboard.chord("s", ctrl=True)
        time.sleep(2.0)
        saved = scratch.read_bytes().decode("utf-8", "replace")
        if "日本" in saved:
            print("PASS: fcitx5/mozc composition reached the editor and saved as UTF-8")
            return 0
        print(f"FAIL: no composed text in the saved file: {saved!r}")
        return 1
    finally:
        for process in (app, im):
            process.terminate()
        if x11 is not None:
            x11.close()
        import shutil
        shutil.rmtree(scratch_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
