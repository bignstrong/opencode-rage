"""Offline tests for the Mac calibration launcher. No microphone, device or network."""
import array
import contextlib
import importlib.util
import io
import json
import math
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("calibrate", SCRIPTS / "calibrate-wake.py")
wizard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wizard)


class WakeCalibration(unittest.TestCase):
    def test_context_sample_requires_audition_and_manual_cut(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            word = array.array("h", [int(math.sin(i / 6) * 5000) for i in range(6400)]).tobytes()
            for n in range(1, 5):
                wizard.save_wav(root / f"{n}.wav", bytes(960) + word + bytes(960))
            command = bytes(6400) + word + word * 3 + bytes(9600)
            with patch.object(wizard.subprocess, "run") as player, \
                    patch("builtins.input", side_effect=["+", "-", ""]), contextlib.redirect_stdout(io.StringIO()):
                clip = wizard.select_name(command, root, root)
            self.assertEqual(player.call_count, 3)
            self.assertEqual(clip, bytes(960) + word)
            self.assertFalse((root / "preview.wav").exists())

    def test_trim_excludes_keyboard_click_and_rejects_silence(self):
        samples = array.array("h", [0]) * 16000
        samples[100] = 32000
        for i in range(8000, 12800):
            samples[i] = int(math.sin(i / 6) * 5000)
        energy, gate, _ = wizard.levels(samples.tobytes())
        self.assertEqual(wizard.bounds(energy, gate, 150), (50, 80))
        energy, gate, _ = wizard.levels(bytes(32000))
        with self.assertRaisesRegex(ValueError, "фон"):
            wizard.bounds(energy, gate, 150)

    def test_failed_fluent_probe_preserves_samples_and_checks_negatives(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            profiles = base / "profiles"
            profiles.mkdir()
            (profiles / "previous").mkdir()
            (profiles / "current").symlink_to("previous")
            fixtures = {}
            def pcm(prompt):
                if prompt not in fixtures:
                    subprocess.run(["say", "-v", "Milena", "-o", str(base / "s.aiff"), prompt], check=True)
                    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
                                    base / "s.aiff", base / "s.wav"], check=True)
                    with wave.open(str(base / "s.wav"), "rb") as f:
                        fixtures[prompt] = bytes(6400) + f.readframes(f.getnframes()) + bytes(9600)
                return fixtures[prompt]

            prompts = []
            def fake_capture(_, __, prompt, seconds, role="enrollment"):
                prompts.append((prompt, seconds))
                if prompt == "помолчи":
                    return bytes(32000)
                # A clearly audible non-name replaces the requested command during validation.
                return pcm("лимон" if seconds == 4 and prompt.startswith("Рейдж ") else prompt)

            with patch.object(wizard, "capture", side_effect=fake_capture), \
                    patch("builtins.input", return_value=""), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "Образцы сохранены"):
                    wizard.enroll("unused", ":test", profiles)
                self.assertEqual(len(list((profiles / "pending").glob("*.wav"))), 8)
                self.assertEqual((profiles / "current").resolve(), (profiles / "previous").resolve())
                prompts.clear()
                with self.assertRaisesRegex(ValueError, "Образцы сохранены"):
                    wizard.enroll("unused", ":test", profiles)
            self.assertTrue(all(seconds == 4 for _, seconds in prompts))
            report = json.loads((profiles / "last-check.json").read_text())
            rows = {row["prompt"]: row for row in report["checks"]}
            self.assertFalse(rows["Рейдж открой настройки"]["passed"])
            self.assertTrue(rows["помолчи"]["passed"])
            self.assertIn("моя речь", rows)
            self.assertEqual(len(report["leave_one_out"]), 6)
            self.assertFalse(list(profiles.rglob("*.pcm")))
            def valid_capture(_, __, prompt, seconds, role="enrollment"):
                if prompt.startswith("Рейдж "):
                    return pcm("Рейдж") + pcm(prompt.split(" ", 1)[1])
                return fake_capture(_, __, prompt, seconds)
            with patch.object(wizard, "capture", side_effect=valid_capture), \
                    patch("builtins.input", return_value=""), contextlib.redirect_stdout(io.StringIO()):
                wizard.enroll("unused", ":test", profiles)
            self.assertNotEqual((profiles / "current").resolve(), (profiles / "previous").resolve())
            self.assertEqual(len(list((profiles / "current").glob("*.wav"))), 8)


if __name__ == "__main__":
    unittest.main()
