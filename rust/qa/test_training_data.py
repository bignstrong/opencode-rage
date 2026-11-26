"""Check that unverified transcripts and prompts cannot leak into training labels."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import training_data as data


class TrainingData(unittest.TestCase):
    def test_review_keeps_guess_and_exports_only_confirmed_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            p = data.save_calibration(root, bytes(3200), "Рейдж", "validation")
            meta = json.loads((p / "meta.json").read_text())
            self.assertIsNone(meta["reference_text"])
            self.assertEqual((p / "audio.wav").stat().st_mode & 0o777, 0o600)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                data.manifest(root)
            self.assertEqual(out.getvalue(), "")
            with patch("builtins.input", side_effect=["=", "рейс"]), contextlib.redirect_stdout(io.StringIO()):
                data.review(root)
            with contextlib.redirect_stdout(out):
                data.manifest(root)
            self.assertEqual(json.loads(out.getvalue())["text"], "рейс")
            self.assertEqual(json.loads((p / "meta.json").read_text()), meta)


if __name__ == "__main__":
    unittest.main()
