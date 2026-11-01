#!/usr/bin/env python3
"""Linux-only native keyboard smoke for Folio's real Tauri/WebKit editor.

This script deliberately does not use JavaScript, DOM events, execCommand,
Tauri IPC mocks, or Folio's debug probe. It launches the actual debug binary
with a disposable Markdown file under an isolated X display/session, focuses the
application's X11 window, and injects OS-level keys through XTest.

Honest limits:
  * XTest input is synthetic OS input. It is not physical hardware and it does
    not exercise an IME/composition path.
  * The caller must provide the isolated display/session. Use the companion
    tests/native-editor-keyboard.sh runner, which starts a private D-Bus session
    and a private Xvfb (dbus-run-session -- xvfb-run).
  * The script only focuses a window whose _NET_WM_PID equals the process it
    launched (title fallback is allowed only under the isolated runner marker).
    It never closes or focuses unrelated windows.

The smoke checks exact saved bytes rather than a screenshot or DOM state:
  1. CtrlEnd, type " native".
  2. Type " source" in the formatted editor.
  3. CtrlS checkpoint, exact bytes.
  4. CtrlE back to rich, type " rich".
  5. CtrlS, exact bytes.
  6. CtrlZ, CtrlS, exact bytes for the prior checkpoint.
  7. Final exact-byte save with no presentation switch.

Run:
  tests/native-editor-keyboard.sh
or, if the caller already provides an isolated Xvfb + private D-Bus session:
  FOLIO_NATIVE_KEYBOARD_ISOLATED=1 python3 tests/native-editor-keyboard.py
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, NoReturn, Optional

ISOLATED_ENV = "FOLIO_NATIVE_KEYBOARD_ISOLATED"
INITIAL = b"# Native keyboard\n\nParagraph.\n"
AFTER_SOURCE = b"# Native keyboard\n\nParagraph. native source\n"
AFTER_RICH = b"# Native keyboard\n\nParagraph. native source rich\n"
# The task line is last and has no trailing newline on purpose: CodeMirror's
# Markdown keymap legitimately auto-continues a list when Enter follows a task
# item. This sample still exercises shifted characters (#, |, [, ]) and exact
# task/table source without depending on that continuation behavior.
SECOND_SOURCE = (
    b"# Source native\n\n"
    b"| A | B |\n"
    b"| --- | --- |\n"
    b"| 1 | 2 |\n\n"
    b"- [x] Done"
)

# Xlib constants.
ANY_PROPERTY_TYPE = 0
IS_VIEWABLE = 2
REVERT_TO_PARENT = 2


class SmokeError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise SmokeError(message)


def wait_for(
    predicate: Callable[[], object],
    timeout: float,
    label: str,
    process: Optional[subprocess.Popen] = None,
) -> object:
    """Bounded condition wait; never a long fixed sleep."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            fail(f"{label}: application exited with status {process.returncode}")
        try:
            value = predicate()
            if value:
                return value
            last = None
        except SmokeError:
            raise
        except Exception as error:  # Xlib transient failure while a window is mapped
            last = error
        time.sleep(0.03)
    suffix = f" (last error: {last})" if last else ""
    fail(f"timed out waiting for {label}{suffix}")


def _load_library(name: str) -> ctypes.CDLL:
    path = ctypes.util.find_library(name)
    if not path:
        fail(f"missing {name}; install libX11/libXtst or skip this Linux smoke")
    return ctypes.CDLL(path)


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p),
        ("root", ctypes.c_ulong),
        ("window_class", ctypes.c_int),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


class X11:
    def __init__(self) -> None:
        self.xlib = _load_library("X11")
        self.xtst = _load_library("Xtst")
        self._declare()
        display = os.environ.get("DISPLAY")
        if not display:
            fail("DISPLAY is not set; run through tests/native-editor-keyboard.sh")
        self.display = self.xlib.XOpenDisplay(display.encode())
        if not self.display:
            fail(f"cannot open X display {display!r}")
        self.root = self.xlib.XDefaultRootWindow(self.display)
        self._atoms: dict[str, int] = {}
        self._verify_xtest()

    def _declare(self) -> None:
        lib = self.xlib
        lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        lib.XOpenDisplay.restype = ctypes.c_void_p
        lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        lib.XDefaultRootWindow.restype = ctypes.c_ulong
        lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        lib.XInternAtom.restype = ctypes.c_ulong
        lib.XQueryTree.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
            ctypes.POINTER(ctypes.c_uint),
        ]
        lib.XQueryTree.restype = ctypes.c_int
        lib.XFetchName.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_char_p),
        ]
        lib.XFetchName.restype = ctypes.c_int
        lib.XGetWindowProperty.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_ulong,
            ctypes.c_long,
            ctypes.c_long,
            ctypes.c_int,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
        ]
        lib.XGetWindowProperty.restype = ctypes.c_int
        lib.XFree.argtypes = [ctypes.c_void_p]
        lib.XFree.restype = ctypes.c_int
        lib.XGetWindowAttributes.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(XWindowAttributes),
        ]
        lib.XGetWindowAttributes.restype = ctypes.c_int
        lib.XSetInputFocus.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        lib.XSetInputFocus.restype = ctypes.c_int
        lib.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        lib.XRaiseWindow.restype = ctypes.c_int
        lib.XFlush.argtypes = [ctypes.c_void_p]
        lib.XFlush.restype = ctypes.c_int
        lib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.XSync.restype = ctypes.c_int
        lib.XDisplayKeycodes.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        lib.XDisplayKeycodes.restype = ctypes.c_int
        lib.XGetKeyboardMapping.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ubyte,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_int),
        ]
        lib.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
        lib.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        lib.XKeysymToKeycode.restype = ctypes.c_ubyte
        lib.XStringToKeysym.argtypes = [ctypes.c_char_p]
        lib.XStringToKeysym.restype = ctypes.c_ulong

        xtst = self.xtst
        xtst.XTestQueryExtension.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        xtst.XTestQueryExtension.restype = ctypes.c_int
        xtst.XTestFakeKeyEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        xtst.XTestFakeKeyEvent.restype = ctypes.c_int

    def _verify_xtest(self) -> None:
        event_base = ctypes.c_int()
        error_base = ctypes.c_int()
        major = ctypes.c_int()
        minor = ctypes.c_int()
        if not self.xtst.XTestQueryExtension(
            self.display,
            ctypes.byref(event_base),
            ctypes.byref(error_base),
            ctypes.byref(major),
            ctypes.byref(minor),
        ):
            fail("the X server does not provide the XTest extension")

    def close(self) -> None:
        if getattr(self, "display", None):
            self.xlib.XCloseDisplay(self.display)
            self.display = None

    def atom(self, name: str) -> int:
        if name not in self._atoms:
            self._atoms[name] = self.xlib.XInternAtom(
                self.display, name.encode(), False
            )
        return self._atoms[name]

    def _property(self, window: int, name: str) -> Optional[tuple[bytes, int, int]]:
        actual_type = ctypes.c_ulong()
        actual_format = ctypes.c_int()
        nitems = ctypes.c_ulong()
        bytes_after = ctypes.c_ulong()
        data = ctypes.POINTER(ctypes.c_ubyte)()
        status = self.xlib.XGetWindowProperty(
            self.display,
            window,
            self.atom(name),
            0,
            1024,
            False,
            ANY_PROPERTY_TYPE,
            ctypes.byref(actual_type),
            ctypes.byref(actual_format),
            ctypes.byref(nitems),
            ctypes.byref(bytes_after),
            ctypes.byref(data),
        )
        if status != 0 or not data:
            return None
        try:
            # Xlib returns format-32 properties as an array of C longs, so the
            # backing allocation is nitems * sizeof(long), not nitems * 4.
            if actual_format.value == 32:
                size = nitems.value * ctypes.sizeof(ctypes.c_ulong)
            else:
                size = nitems.value * max(1, actual_format.value // 8)
            return (
                ctypes.string_at(data, size),
                int(actual_type.value),
                int(actual_format.value),
            )
        finally:
            self.xlib.XFree(ctypes.cast(data, ctypes.c_void_p))

    def window_title(self, window: int) -> str:
        net_name = self._property(window, "_NET_WM_NAME")
        if net_name:
            raw, _actual_type, _format = net_name
            if raw:
                return raw.decode("utf-8", "replace")
        name = ctypes.c_char_p()
        if self.xlib.XFetchName(self.display, window, ctypes.byref(name)) and name.value:
            try:
                return name.value.decode("utf-8", "replace")
            finally:
                self.xlib.XFree(ctypes.cast(name, ctypes.c_void_p))
        return ""

    def window_pid(self, window: int) -> Optional[int]:
        prop = self._property(window, "_NET_WM_PID")
        if not prop:
            return None
        raw, _actual_type, actual_format = prop
        if actual_format != 32 or len(raw) < ctypes.sizeof(ctypes.c_ulong):
            return None
        values = ctypes.cast(raw, ctypes.POINTER(ctypes.c_ulong))
        return int(values[0])

    def attributes(self, window: int) -> Optional[XWindowAttributes]:
        attrs = XWindowAttributes()
        if not self.xlib.XGetWindowAttributes(
            self.display, window, ctypes.byref(attrs)
        ):
            return None
        return attrs

    def all_windows(self) -> list[int]:
        result: list[int] = []
        stack = [int(self.root)]
        while stack:
            window = stack.pop()
            result.append(window)
            root_return = ctypes.c_ulong()
            parent_return = ctypes.c_ulong()
            children = ctypes.POINTER(ctypes.c_ulong)()
            count = ctypes.c_uint()
            if not self.xlib.XQueryTree(
                self.display,
                window,
                ctypes.byref(root_return),
                ctypes.byref(parent_return),
                ctypes.byref(children),
                ctypes.byref(count),
            ):
                continue
            try:
                for index in range(count.value):
                    stack.append(int(children[index]))
            finally:
                if children:
                    self.xlib.XFree(ctypes.cast(children, ctypes.c_void_p))
        return result

    def find_app_windows(self, pid: int, isolated: bool) -> list[int]:
        matches: list[int] = []
        for window in self.all_windows():
            attrs = self.attributes(window)
            if not attrs or attrs.map_state != IS_VIEWABLE:
                continue
            if attrs.width < 300 or attrs.height < 200:
                continue
            title = self.window_title(window)
            if "Folio" not in title:
                continue
            owner = self.window_pid(window)
            if owner == pid:
                matches.append(window)
            elif owner is None and isolated:
                # Only the isolated runner may fall back to a title match; this
                # keeps the script away from a user's existing Folio windows.
                matches.append(window)
        return matches

    def focus(self, window: int) -> None:
        self.xlib.XRaiseWindow(self.display, window)
        self.xlib.XSetInputFocus(self.display, window, REVERT_TO_PARENT, 0)
        self.xlib.XSync(self.display, False)


class Keyboard:
    SPECIAL = {
        "End": "End",
        "Home": "Home",
        "Return": "Return",
        "Enter": "Return",
        "Tab": "Tab",
        "Escape": "Escape",
        "BackSpace": "BackSpace",
        "Delete": "Delete",
        "Left": "Left",
        "Right": "Right",
        "Up": "Up",
        "Down": "Down",
        "PageUp": "Prior",
        "PageDown": "Next",
    }
    MODIFIERS = {
        "ctrl": "Control_L",
        "shift": "Shift_L",
        "alt": "Alt_L",
        "meta": "Super_L",
    }

    def __init__(self, x11: X11) -> None:
        self.x = x11
        self.by_char: dict[str, tuple[int, int]] = {}
        self.special_codes: dict[str, int] = {}
        self.modifier_codes: dict[str, int] = {}
        self._load_keymap()

    def _load_keymap(self) -> None:
        minimum = ctypes.c_int()
        maximum = ctypes.c_int()
        self.x.xlib.XDisplayKeycodes(
            self.x.display, ctypes.byref(minimum), ctypes.byref(maximum)
        )
        per_code = ctypes.c_int()
        mapping = self.x.xlib.XGetKeyboardMapping(
            self.x.display,
            minimum.value,
            maximum.value - minimum.value + 1,
            ctypes.byref(per_code),
        )
        if not mapping:
            fail("cannot read the X keyboard mapping")
        try:
            for code in range(minimum.value, maximum.value + 1):
                base = (code - minimum.value) * per_code.value
                # Level 0 is unshifted; level 1 is shifted. ASCII punctuation
                # and uppercase letters live on these two levels on the Xvfb
                # default keyboard map.
                for level in (0, 1):
                    if level >= per_code.value:
                        continue
                    keysym = int(mapping[base + level])
                    if not keysym:
                        continue
                    if 0x20 <= keysym <= 0x7E:
                        char = chr(keysym)
                        self.by_char.setdefault(char, (code, level))
        finally:
            self.x.xlib.XFree(ctypes.cast(mapping, ctypes.c_void_p))

        for name, keysym_name in self.SPECIAL.items():
            keysym = self.x.xlib.XStringToKeysym(keysym_name.encode())
            code = int(self.x.xlib.XKeysymToKeycode(self.x.display, keysym))
            if not code:
                fail(f"cannot map special key {name!r}")
            self.special_codes[name] = code
        for name, keysym_name in self.MODIFIERS.items():
            keysym = self.x.xlib.XStringToKeysym(keysym_name.encode())
            code = int(self.x.xlib.XKeysymToKeycode(self.x.display, keysym))
            if not code:
                fail(f"cannot map modifier {name!r}")
            self.modifier_codes[name] = code

    def _fake(self, code: int, pressed: bool) -> None:
        if not self.x.xtst.XTestFakeKeyEvent(
            self.x.display, code, 1 if pressed else 0, 0
        ):
            fail(f"XTestFakeKeyEvent failed for keycode {code}")

    @staticmethod
    def _micro_delay() -> None:
        # Small, constant delivery spacing; no multi-second sleeps.
        time.sleep(0.012)

    def key_code(self, key: str) -> tuple[int, int]:
        """Return (keycode, shift_level) for a printable ASCII character."""
        if key in self.special_codes:
            return self.special_codes[key], 0
        if key in self.by_char:
            return self.by_char[key]
        fail(f"no X keycode for character {key!r} (ASCII only)")

    def chord(
        self,
        key: str,
        ctrl: bool = False,
        shift: bool = False,
        alt: bool = False,
        meta: bool = False,
    ) -> None:
        code, level = self.key_code(key)
        modifiers = []
        if ctrl:
            modifiers.append("ctrl")
        if shift or level == 1:
            modifiers.append("shift")
        if alt:
            modifiers.append("alt")
        if meta:
            modifiers.append("meta")
        pressed = []
        try:
            for name in modifiers:
                self._fake(self.modifier_codes[name], True)
                pressed.append(name)
            self._fake(code, True)
            self._micro_delay()
            self._fake(code, False)
        finally:
            for name in reversed(pressed):
                self._fake(self.modifier_codes[name], False)
            self.x.xlib.XFlush(self.x.display)
        self._micro_delay()

    def type_text(self, text: str) -> None:
        for char in text:
            if char == "\n":
                self.chord("Return")
            elif char == "\t":
                self.chord("Tab")
            elif char in ("\r",):
                continue
            else:
                self.chord(char)


def read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return b""


def wait_for_file(path: Path, expected: bytes, timeout: float, label: str) -> bytes:
    def matches() -> bool:
        return read_bytes(path) == expected

    wait_for(matches, timeout, label)
    return read_bytes(path)


def title_is_dirty(title: str) -> bool:
    return "●" in title


def show_bytes(label: str, value: bytes) -> str:
    return f"{label}={value!r}"


class Smoke:
    def __init__(self, x11: X11, keyboard: Keyboard, window: int, scratch: Path) -> None:
        self.x = x11
        self.kb = keyboard
        self.window = window
        self.scratch = scratch
        self.owner_pid = x11.window_pid(window)
        self.steps: list[str] = []

    def title(self) -> str:
        return self.x.window_title(self.window)

    def log(self, message: str) -> None:
        self.steps.append(message)
        print(f"  {message}")

    def wait_clean(self, label: str) -> None:
        wait_for(
            lambda: not title_is_dirty(self.title()),
            5.0,
            f"{label}: title to clear dirty marker",
        )

    def wait_dirty(self, label: str) -> None:
        wait_for(
            lambda: title_is_dirty(self.title()),
            5.0,
            f"{label}: title to show dirty marker",
        )

    def save_and_expect(self, expected: bytes, label: str) -> bytes:
        self.wait_for_focus()
        self.kb.chord("s", ctrl=True)
        actual = wait_for_file(self.scratch, expected, 10.0, f"{label}: saved bytes")
        self.wait_clean(label)
        self.log(f"{label}: {show_bytes('saved', actual)}")
        return actual

    def wait_for_focus(self) -> None:
        # Keep the app's top-level window focused between phases. No window is
        # closed or touched besides the PID-matched app under test.
        self.x.focus(self.window)
        time.sleep(0.03)

    def run(self) -> None:
        self.wait_for_focus()
        initial = read_bytes(self.scratch)
        if initial != INITIAL:
            fail(
                "opening the scratch document changed it before input: "
                f"{show_bytes('actual', initial)}"
            )
        self.log("initial scratch unchanged before input")

        # Case 1: rich editor keyboard input.
        self.kb.chord("End", ctrl=True)
        self.kb.type_text(" native")
        self.wait_dirty("native typing")
        self.log("rich CtrlEnd + typed ' native'")

        self.kb.type_text(" source")
        self.wait_dirty("second typing group")
        self.log("typed ' source' in the formatted editor")

        # This first save is a deliberate undo-group checkpoint. The app's
        # checkpoint() resets typing grouping; it does not flush a history
        # snapshot, so saving before the final short burst makes the later
        # CtrlZ remove only that final burst. It also exercises native save
        # before the final roundtrip.
        after_source = self.save_and_expect(AFTER_SOURCE, "checkpoint save")
        if after_source != AFTER_SOURCE:
            fail("checkpoint save text changed unexpectedly")

        # Type the final group, and save again.
        self.kb.type_text(" rich")
        self.wait_dirty("rich typing")
        after_rich = self.save_and_expect(AFTER_RICH, "final save")
        if after_rich != AFTER_RICH:
            fail("final save text changed unexpectedly")

        # CtrlZ must remove only the final ' rich' group, not the earlier text.
        self.kb.chord("z", ctrl=True)
        self.wait_dirty("undo")
        time.sleep(0.08)
        after_undo = self.save_and_expect(AFTER_SOURCE, "undo save")
        if after_undo != AFTER_SOURCE:
            fail("CtrlZ removed more than the last typing group")

        # Single editor: a final save must still produce the exact bytes and
        # the dirty state must clear without any presentation round trip.
        self.wait_clean("post-typing")
        final = self.save_and_expect(AFTER_SOURCE, "post-undo save")
        self.log(f"typed roundtrip exact: {show_bytes('bytes', final)}")

    def report(self) -> None:
        print("PASS: native XTest keyboard drove real Folio/WebKit")
        print(f"  window title: {self.title()!r}")
        print(f"  _NET_WM_PID: {self.owner_pid}")
        print(f"  scratch: {self.scratch}")
        for step in self.steps:
            print(f"  - {step}")
        print(
            "  note: synthetic OS input via XTest; not physical hardware, "
            "not an IME/composition test"
        )


def terminate_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    repo_root = Path(__file__).resolve().parents[1]
    parser.add_argument(
        "--binary",
        type=Path,
        default=repo_root / "target" / "debug" / "folio",
        help="Folio debug binary (default: target/debug/folio)",
    )
    parser.add_argument(
        "--scratch-dir",
        type=Path,
        default=None,
        help="directory for the disposable Markdown file and app log",
    )
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=30.0,
        help="seconds to wait for the app window (default: 30)",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="keep the temporary directory even on success",
    )
    args = parser.parse_args()

    if sys.platform != "linux":
        print("FAIL: this smoke is Linux-only (X11/XTest)", file=sys.stderr)
        return 2
    if os.environ.get(ISOLATED_ENV) != "1":
        print(
            "FAIL: refusing to run outside the isolated runner. "
            "Use tests/native-editor-keyboard.sh (private D-Bus + Xvfb), or set "
            f"{ISOLATED_ENV}=1 only when the caller already provides isolation.",
            file=sys.stderr,
        )
        return 2
    if not os.environ.get("DISPLAY"):
        print("FAIL: DISPLAY is not set", file=sys.stderr)
        return 2

    binary = args.binary.expanduser().resolve()
    if not binary.is_file():
        print(f"FAIL: Folio binary not found: {binary}", file=sys.stderr)
        return 2

    owns_scratch_dir = args.scratch_dir is None
    scratch_dir = (
        args.scratch_dir.expanduser().resolve()
        if args.scratch_dir
        else Path(tempfile.mkdtemp(prefix="folio-native-keyboard-"))
    )
    scratch_dir.mkdir(parents=True, exist_ok=True)
    scratch = scratch_dir / "native-keyboard.md"
    scratch.write_bytes(INITIAL)
    log_path = scratch_dir / "app.log"
    log = log_path.open("wb")

    env = os.environ.copy()
    env.pop("FOLIO_NATIVE_PROBE", None)
    env["GDK_BACKEND"] = "x11"
    process = subprocess.Popen(
        [str(binary), str(scratch)],
        cwd=str(repo_root),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    x11: Optional[X11] = None
    keep = args.keep
    try:
        x11 = X11()
        isolated = os.environ.get(ISOLATED_ENV) == "1"

        def window_area(window: int) -> int:
            attrs = x11.attributes(window)
            return attrs.width * attrs.height if attrs else 0

        def find_window() -> Optional[int]:
            matches = x11.find_app_windows(process.pid, isolated)
            if not matches:
                return None
            return max(matches, key=window_area)

        window = int(
            wait_for(
                find_window,
                args.startup_timeout,
                "Folio X11 window for the launched PID",
                process,
            )
        )
        x11.focus(window)
        # Wait until the app has finished opening the disposable document.
        wait_for(
            lambda: scratch.name in x11.window_title(window)
            and "Folio" in x11.window_title(window),
            args.startup_timeout,
            "document title after startup",
            process,
        )
        # Give the lazy editor bundle and initial ProseMirror mount a bounded
        # moment to settle. The title updates before mountUnifiedEditor() creates
        # the DOM, so this is a readiness margin, not the primary condition.
        time.sleep(0.40)
        x11.focus(window)
        title = x11.window_title(window)
        if title_is_dirty(title):
            fail(f"new document unexpectedly starts dirty: {title!r}")

        keyboard = Keyboard(x11)
        smoke = Smoke(x11, keyboard, window, scratch)
        smoke.run()
        smoke.report()
        return 0
    except SmokeError as error:
        keep = True
        title = ""
        if x11 is not None:
            try:
                matches = x11.find_app_windows(process.pid, True)
                if matches:
                    title = x11.window_title(matches[0])
            except Exception:
                pass
        print(f"FAIL: {error}", file=sys.stderr)
        if title:
            print(f"  last window title: {title!r}", file=sys.stderr)
        print(f"  expected scratch: {scratch}", file=sys.stderr)
        print(f"  actual bytes: {read_bytes(scratch)!r}", file=sys.stderr)
        print(f"  app log: {log_path}", file=sys.stderr)
        return 1
    except Exception as error:
        keep = True
        print(f"FAIL: unexpected {type(error).__name__}: {error}", file=sys.stderr)
        print(f"  app log: {log_path}", file=sys.stderr)
        return 1
    finally:
        terminate_process(process)
        try:
            log.close()
        except Exception:
            pass
        if x11 is not None:
            try:
                x11.close()
            except Exception:
                pass
        if keep or not owns_scratch_dir:
            print(f"Artifacts kept in {scratch_dir}")
        else:
            shutil.rmtree(scratch_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
