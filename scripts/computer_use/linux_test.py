"""Regression checks for X11 text mapping transactions; no desktop required."""
import ctypes as C
import unittest
from unittest.mock import patch

from linux import X11Desktop, text_keysym


class FakeX:
    def __init__(self):
        self.grabbed = False
        self.maps = {code: [0, 0] for code in range(8, 16)}
        self.maps[8] = [ord("a"), ord("A")]
        self.original = {code: list(values) for code, values in self.maps.items()}
        self.transactions = []

    def XDisplayKeycodes(self, _display, minimum, maximum):
        minimum._obj.value, maximum._obj.value = 8, 15

    def XGetKeyboardMapping(self, _display, first, count, per):
        per._obj.value = 2
        return (C.c_ulong * (count * 2))(*[value for code in range(first, first + count)
                                        for value in self.maps[code]])

    def XFree(self, _mapping):
        pass

    def XGrabServer(self, _display):
        assert not self.grabbed
        self.grabbed = True

    def XChangeKeyboardMapping(self, _display, code, per, symbols, count):
        assert self.grabbed, "Another client could read a partial glyph map."
        assert count == 1
        self.maps[code] = list(symbols)[:per]

    def XUngrabServer(self, _display):
        assert self.grabbed
        self.grabbed = False
        self.transactions.append({code: list(values) for code, values in self.maps.items()})

    def XSync(self, _display, _discard):
        assert not self.grabbed

    def XFlush(self, _display):
        assert not self.grabbed


class FakeInput:
    def __init__(self, x):
        self.x = x
        self.typed = []
        self.held = set()
        self.fail = False

    def XTestFakeKeyEvent(self, _display, code, down, _delay):
        assert not self.x.grabbed, "Input must never run while the X server is grabbed."
        if down:
            if self.fail:
                return 0
            self.held.add(code)
            self.typed.append(self.x.maps[code][0])
        else:
            self.held.discard(code)
        return 1


class TextInputTests(unittest.TestCase):
    def setUp(self):
        self.desktop = X11Desktop.__new__(X11Desktop)
        self.desktop.x = FakeX()
        self.desktop.test = FakeInput(self.desktop.x)
        self.desktop.display = 1
        self.sleep = patch("linux.time.sleep", self.pause).start()
        self.addCleanup(patch.stopall)

    def pause(self, _seconds):
        self.assertFalse(self.desktop.x.grabbed, "Sleeping under a server grab freezes other clients.")

    def test_unicode_across_multiple_batches_keeps_original_layout(self):
        text = "Mukai café 世界 🌱 Ωαβ你好再见\n\t" * 3
        self.desktop.type(text)
        self.assertEqual(self.desktop.test.typed, [text_keysym(char) for char in text])
        self.assertEqual(self.desktop.x.maps, self.desktop.x.original)
        self.assertEqual(self.desktop.test.held, set())
        self.assertGreater(len(self.desktop.x.transactions), 2)
        self.desktop.type("replaced")
        self.assertEqual(self.desktop.x.maps, self.desktop.x.original)

    def test_injection_failure_releases_keys_and_restores_mapping(self):
        self.desktop.test.fail = True
        with self.assertRaisesRegex(RuntimeError, "key press failed"):
            self.desktop.type("🌱")
        self.assertEqual(self.desktop.x.maps, self.desktop.x.original)
        self.assertFalse(self.desktop.x.grabbed)
        self.assertEqual(self.desktop.test.held, set())

    def test_mapping_exception_always_releases_server_grab(self):
        with patch.object(self.desktop.x, "XChangeKeyboardMapping", side_effect=RuntimeError("failure")):
            with self.assertRaisesRegex(RuntimeError, "failure"):
                self.desktop.change_keymap({15: [ord("M"), ord("M")]}, 2)
        self.assertFalse(self.desktop.x.grabbed)

    def test_no_spare_keycode_does_not_change_the_layout(self):
        for code in self.desktop.x.maps:
            self.desktop.x.maps[code] = [ord("a"), ord("A")]
        with self.assertRaisesRegex(RuntimeError, "No unused X11 keycode"):
            self.desktop.type("🌱")
        self.assertEqual(self.desktop.x.transactions, [])

    def test_empty_text_does_not_touch_the_layout(self):
        self.desktop.type("")
        self.assertEqual(self.desktop.x.transactions, [])


if __name__ == "__main__":
    unittest.main()
