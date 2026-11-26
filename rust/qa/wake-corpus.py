"""Offline wake-word corpus. macOS say writes files; audio never goes to a device."""
import argparse
from array import array
import math
from pathlib import Path
import random
import statistics
import subprocess
import sys
import tempfile
import time
import wave

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "native/target/wake-corpus"
DRIVER = OUT / "driver"
RATE = 16000
VOICE = "Milena"


def build():
    subprocess.run(["rustc", "--edition=2024", "-O", ROOT / "rust/qa/wake-corpus-driver.rs",
                    "-o", DRIVER], check=True)


def tts(text, rate, voice=VOICE):
    path = OUT / f"{voice}-{rate}-{text}.wav"
    if not path.exists():
        subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", path,
                        "--file-format=WAVE", "--data-format=LEI16@16000", text], check=True)
    with wave.open(str(path)) as src:
        assert (src.getframerate(), src.getsampwidth(), src.getnchannels()) == (RATE, 2, 1)
        return array("h", src.readframes(src.getnframes()))


def adapt(pcm, speed=1, gain=1, noise=0):
    rng = random.Random(417)
    out = array("h")
    for i in range(int((len(pcm) - 1) / speed)):
        x = i * speed
        j = int(x)
        v = (pcm[j] + (x - j) * (pcm[j + 1] - pcm[j])) * gain
        out.append(int(max(-32768, min(32767, v + rng.uniform(-noise, noise)))))
    return out


def silence(seconds):
    return array("h", [0]) * round(seconds * RATE)


def pcmfile(pcm):
    path = OUT / "input.s16le"
    assert sys.byteorder == "little"
    path.write_bytes(pcm.tobytes())
    return path


def templates():
    # Frame endpoints mark the final affricate, before the following phoneme.
    bank = bytearray()
    for speed in [1., .84, 1.18]:
        for text, end in [("Рейдж", 54), ("Рейдж напиши письмо", 47),
                          ("Рейдж давай поговорим", 40), ("речь", 33), ("рейс", 45)]:
            pcm = adapt(tts(text, 160), speed)
            frames = round(end / speed)
            subprocess.run([DRIVER, "template", pcmfile(pcm), str(frames), OUT / "template.bands"], check=True)
            data = (OUT / "template.bands").read_bytes()
            assert len(data) == frames * 16
            bank.append(frames)
            bank.extend(data)
    (ROOT / "native/wake-assets/milena.bank").write_bytes(bank)


def background(seconds):
    rng = random.Random(9301)
    samples = silence(seconds)
    for i in range(len(samples)):
        # Fan noise, mains hum, periodic broadband clicks, alternating silence.
        block = i // RATE % 4
        if block == 0:
            continue
        click = 2600 * math.exp(-(i % 7319) / 80)
        samples[i] = int(rng.uniform(-1, 1) * (block * 130 + click) + 400 * math.sin(i * 2 * math.pi * 50 / RATE))
    return samples


def run(split):
    signal = silence(0.5)
    cases = []

    def add(label, audio, word=None):
        begin = len(signal) / RATE
        signal.extend(audio)
        signal.extend(silence(.25))
        end = len(signal) / RATE
        cases.append((label, begin, end, None if word is None else (begin + word[0], begin + word[1])))

    if split == "dev":
        rates = [145, 185]
        positives = ["Рейдж", "Рейдж открой настройки", "Рейдж включи свет", "Рейдж, запиши встречу",
                     "Рейдж дай совет"]
        negatives = ["рейс", "речь", "рейс отменили", "речь идёт о погоде", "режь", "рейд", "включи запись",
                     "дождь", "реже", "рейка", "реки", "грейпфрут", "который час", "рей", "рейтинг",
                     "режиссер", "Слушай открой окно", "Ну хорошо скажи время", "эй, ты где"]
        transforms = [(1., 1., 0), (.95, .35, 80), (.88, .45, 60), (1.12, .55, 90),
                      (.79, .32, 120), (1.23, .62, 100)]
    elif split == "held-out":
        rates = [132, 173, 212]
        positives = ["Рейдж запомни адрес", "Рейдж поставь таймер", "Рейдж, где мои ключи", "Рейдж!"]
        negatives = ["этот рейс перенесли на вечер", "наша речь звучит иначе", "речь", "рейс", "рейсы",
                     "речка", "рейд начался утром", "срежь угол", "быстрее же", "режим тишины", "крейсер",
                     "в гараже стоит машина", "включи музыку", "раз два три четыре", "принеси чашку чая"]
        transforms = [(1., .72, 0), (1.09, .42, 140), (.89, .28, 110)]
    else:
        rates = [151, 197]
        positives = ["Рейдж подскажи дорогу", "Рейдж начинай отсчёт", "Рейдж добавь заметку",
                     "Рейдж вызови такси", "Рейдж кто звонил", "Рейдж отправь сообщение"]
        negatives = ["эта речь мне знакома", "утренний рейс в Омск", "измерь радиус", "у нас рейд",
                     "ты же слышал", "эй Джон", "ретушь", "чей же", "рейтинг вырос", "разреши спросить",
                     "мы редко видимся", "разрежь пирог", "успеть на поезд", "слова и жесты", "найди адрес"]
        transforms = [(1.03, .65, 50), (.91, .42, 160), (.82, .33, 160), (1.15, .37, 180)]
    for rate in rates:
        for text in positives:
            for speed, gain, noise in transforms:
                add(f"positive/{rate}/{speed}/{text}", adapt(tts(text, rate), speed, gain, noise), (0.10, .85 / speed))
        for text in negatives:
            for speed, gain, noise in transforms:
                add(f"negative/{rate}/{speed}/{text}", adapt(tts(text, rate), speed, gain, noise))
    # Adjacent utterances, without resetting the detector or inserting a pause after the wake word.
    lead = tts("Теперь слушай" if split == "dev" else "Я вот что скажу", rates[0])
    phrase = tts("Рейдж послушай меня" if split == "dev" else "Рейдж расскажи новости", rates[0])
    add("positive/speech-before-and-after", lead + phrase, (len(lead) / RATE + .10, len(lead) / RATE + .85))
    # Single synthesized utterance: neither side of the word has forced silence.
    before, after = ("Слушай", "открой окно") if split == "dev" else ("Ну хорошо", "скажи время")
    for rate in rates:
        prefix = tts(before, rate)
        active = max(i for i, x in enumerate(prefix) if abs(x) > 100) / RATE
        add(f"positive/embedded/{rate}", tts(f"{before} Рейдж {after}", rate), (active - .1, active + .65))
        add(f"negative/same-context/{rate}", tts(f"{before} {after}", rate))
    add("background/room-simulation", background(30 if split == "dev" else 120))
    subprocess.run([DRIVER, "reset", pcmfile(tts("Рейдж", 160))], check=True)
    path = pcmfile(signal)
    start = time.monotonic()
    proc = subprocess.run([DRIVER, "detect", path], check=True, capture_output=True, text=True)
    duration = time.monotonic() - start
    events = [int(s) / 1000 for s in proc.stdout.splitlines()]
    hits = misses = extras = false = negatives = 0
    offsets = []
    for label, begin, end, window in cases:
        seen = [x for x in events if begin <= x < end]
        if window:
            good = [x for x in seen if window[0] <= x <= window[1]]
            hits += bool(good)
            misses += not good
            extras += len(seen) - bool(good)
            if good and label.split("/")[1].isdigit():
                offsets.append(round((good[0] - begin) * 1000))
            if not good or len(seen) != 1:
                print(f"{label}: events {[round(x-begin, 2) for x in seen]}")
        else:
            negatives += 1
            false += len(seen)
            if seen:
                print(f"{label}: false {[round(x-begin, 2) for x in seen]}")
    print(f"{split}: detected {hits}/{hits+misses}; extra events {extras}; false events {false} on {negatives} negative clips; "
          f"first-word event median {statistics.median(offsets) if offsets else 'n/a'} ms from utterance start; "
          f"{len(signal)/RATE:.1f}s PCM in {duration:.3f}s (includes file IO and child startup)")
    return hits >= .9 * (hits + misses) and not (false or extras)


def voices():
    # These voices do not speak native Russian. Report independently; do not pool with the Russian corpus.
    for voice, positives, negatives in [
        ("Lesya", ["Рейдж", "Рейдж скажи мені"], ["рейс", "річ", "цей рейс скасували"]),
        ("Aru", ["Рейдж"], ["рейс", "речь"]),
        ("Daniel", ["rage", "rage tell me"], ["race", "rich", "read me a story"]),
    ]:
        hits = false = 0
        for text in positives + negatives:
            events = subprocess.check_output([DRIVER, "detect", pcmfile(tts(text, 177, voice))]).splitlines()
            if text in positives:
                hits += bool(events)
            else:
                false += len(events)
        print(f"{voice} (cross-language diagnostic): detected {hits}/{len(positives)}; "
              f"false events {false} on {len(negatives)} negatives")


def validate():
    with tempfile.TemporaryDirectory(dir=OUT) as temp:
        profile = Path(temp)
        pcm = tts("Рейдж", 161)
        raw = pcmfile(pcm)

        def check(ok, message=""):
            result = subprocess.run([DRIVER, "detect", raw, profile], capture_output=True, text=True)
            assert result.returncode == (0 if ok else 2) and message in result.stderr, result
            if ok:
                assert len(result.stdout.splitlines()) == 1

        def wav(name, audio, channels=1):
            with wave.open(str(profile / name), "wb") as out:
                out.setparams((channels, 2, RATE, 0, "NONE", ""))
                out.writeframes(audio.tobytes())

        check(False, "3–8")
        for n in range(3):
            wav(f"{n}.wav", tts("Рейдж", [153, 161, 177][n]))
        check(True)
        extra = profile / "extra.wav"
        extra.symlink_to(profile / "1.wav")
        check(False, "regular WAV")
        extra.unlink()
        extra.write_bytes(b"RIFF\xff\xff\xff\xffWAVE")
        check(False, "length")
        extra.write_bytes(b"x" * 800001)
        check(False, "Expected")
        wav("extra.wav", pcm, channels=2)
        check(False, "Expected")
        wav("extra.wav", silence(.3))
        check(False, "silent")
        wav("extra.wav", pcm[:160])
        check(False, "0.15")
        extra.unlink()
        for n in range(3, 9):
            wav(f"{n}.wav", pcm)
        check(False, "at most 8")
    print("Profile acceptance and 8 rejection cases passed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action", choices=["train", "dev", "held-out", "fresh", "voices", "validate"])
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    build()
    if args.action == "train":
        templates()
    elif args.action == "voices":
        voices()
    elif args.action == "validate":
        validate()
    else:
        sys.exit(0 if run(args.action) else 1)
