"""Test enrollment with an existing local Piper voice. No network, playback, or microphone."""
import argparse
from array import array
from pathlib import Path
import runpy
import subprocess
import tempfile
import wave

from piper import PiperVoice, SynthesisConfig

qa = runpy.run_path(str(Path(__file__).with_name("wake-corpus.py")))
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("model", type=Path)
ap.add_argument("--candidate", type=Path, help="Rustpotter executable taking PROFILE_DIR RAW_PCM")
ap.add_argument("--split", choices=["dev", "test"], default="test")
ap.add_argument("--dev-scores", action="store_true", help="Save development scores under the ignored QA directory")
args = ap.parse_args()
voice = PiperVoice.load(args.model)
qa["OUT"].mkdir(parents=True, exist_ok=True)
qa["build"]()


def synth(path, text, speed):
    with wave.open(str(path), "wb") as out:
        voice.synthesize_wav(text, out, syn_config=SynthesisConfig(length_scale=speed, noise_scale=0., noise_w_scale=0.))


with tempfile.TemporaryDirectory(dir=qa["OUT"]) as tmp:
    root = Path(tmp)
    profile = root / "examples"
    profile.mkdir()
    # Isolated enrollment tokens only. No test audio, word boundaries, or commands enter the profile.
    for i, (text, speed) in enumerate([("Рейдж", .8), ("Рейдж!", .94), ("Рейдж.", 1.08), ("Рейдж?", 1.22)]):
        synth(profile / f"{i}.wav", text, speed)
    # Two fluent enrollment takes, manually cut at the end of the wake word.
    # The annotated times belong only to this Denis voice and these two training sentences.
    for i, (text, end) in enumerate([("Рейдж закажи билет", .49), ("Рейдж разбуди меня", .53)]):
        source = root / "enroll-source.wav"
        synth(source, text, 1.)
        with wave.open(str(source)) as src, wave.open(str(profile / f"fluent-{i}.wav"), "wb") as dst:
            dst.setparams(src.getparams())
            dst.writeframes(src.readframes(round(end * src.getframerate())))
    contrast = root / "contrast"
    contrast.mkdir()
    for path in profile.glob("*.wav"):
        (contrast / path.name).write_bytes(path.read_bytes())
    for text in ["рейс", "речь"]:
        synth(contrast / f"reject-{text}.wav", text, 1.)
    trimmed = root / "trimmed"
    if args.candidate:
        import numpy as np
        trimmed.mkdir()
        for path in profile.glob("*.wav"):
            with wave.open(str(path)) as src, wave.open(str(trimmed / path.name), "wb") as dst:
                dst.setparams(src.getparams())
                samples = np.frombuffer(src.readframes(src.getnframes()), dtype="<i2")
                hop = round(src.getframerate() / 100)
                frames = samples[:len(samples)//hop*hop].reshape(-1, hop).astype(float)
                energy = (frames**2).mean(axis=1)**.5
                active = np.flatnonzero(energy >= max(64., .025 * energy.max()))
                dst.writeframes(samples[active[0]*hop:(active[-1]+1)*hop].tobytes())
    if args.split == "dev":
        positives = ["Рейдж выключи экран", "Рейдж запусти камеру", "Рейдж", "Рейдж, запиши номер"]
        negatives = ["рейс", "речь", "рей", "скажи адрес", "моя речь", "время прошло", "покажи почту"]
        rates = [.85, 1.15]
    else:
        positives = ["Рейдж сделай заметку", "Рейдж дай прогноз", "Рейдж прочти письмо", "Рейдж, который час",
                     "Рейдж найди рецепт", "Рейдж включи будильник"]
        negatives = ["речь идёт о дороге", "этот рейс задержали", "мой рейтинг", "режь хлеб", "ей же виднее",
                     "сильный дождь", "открой письмо", "расскажи прогноз", "рейс", "речь", "я здесь", "подожди"]
        rates = [.88, 1.04, 1.19]
    signal = array("h")
    labels = []
    for rate in rates:
        for text in positives + negatives:
            synth(root / "source.wav", text, rate)
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
                            root / "source.wav", root / "mono.wav"], check=True)
            signal.extend(qa["silence"](.6))
            start = len(signal) / 16000
            with wave.open(str(root / "mono.wav")) as f:
                signal.frombytes(f.readframes(f.getnframes()))
            signal.extend(qa["silence"](.6))
            labels.append((start, len(signal) / 16000, text, rate))
    labels.append((len(signal)/16000, len(signal)/16000 + 30, "background", 1))
    signal.extend(qa["background"](30))
    path = root / "stream.pcm"
    path.write_bytes(signal.tobytes())
    if args.dev_scores:
        assert args.split == "dev"
        import json
        (qa["OUT"] / "dev-labels.json").write_text(json.dumps(labels))
        with (qa["OUT"] / "dev-scores.txt").open("w") as f:
            subprocess.run([qa["DRIVER"], "scores", path, contrast], stdout=f, check=True)
    for name, command in [("built-in", [qa["DRIVER"], "detect", path]),
                          ("enrolled", [qa["DRIVER"], "detect", path, profile]),
                          ("enrolled-with-contrasts", [qa["DRIVER"], "detect", path, contrast]),
                          ("rustpotter-default", [args.candidate, trimmed, path])]:
        if not command[0]:
            continue
        events = [int(s)/1000 for s in subprocess.check_output(command, text=True).splitlines()]
        hits = 0
        late = 0
        for start, end, text, rate in labels:
            seen = [round(s-start, 2) for s in events if start <= s < end]
            good = text in positives and any(.10 <= s <= 1.20 for s in seen)
            hits += bool(good)
            if text in positives and seen and not good:
                late += 1
            if (text in positives and not good) or len(seen) > bool(good):
                print(f"{name}: {rate} {text}: {seen}")
        print(f"{name}: {hits}/{len(positives)*len(rates)} positives, {len(events)-hits} false/extra events "
              f"(including {late} late positive clips), "
              f"{len(negatives)*len(rates)} negative speech clips + 30 s noise, {len(signal)/16000:.1f} s continuous stream")
