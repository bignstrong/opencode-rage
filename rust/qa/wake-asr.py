#!/usr/bin/env python3
"""Offline Russian wake-ASR A/B. Prints JSONL; only creates temporary synthetic WAVs."""
import argparse
from array import array
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import tempfile
import time
import wave

RATE = 16000
FRAME = RATE // 100
PAD = RATE // 5
SANDBOX = ["/usr/bin/sandbox-exec", "-p", "(version 1) (allow default) (deny network*)"]
COMMANDS = [
    ("neurons", 155, "глянь какие есть нейроны", "глянь какие есть нейроны"),
    ("networks", 155, "глянь какие есть нейросети", "глянь какие есть нейросети"),
    ("settings", 185, "открой настройки", "открой настройки"),
    ("repo", 185, "открой репо и покажи последние изменения", "открой репо и покажи последние изменения"),
    ("git", 155, "посмотри статус Git в репозитории", "посмотри статус Git в репозитории"),
    ("clause-pause", 155, "проверь репозиторий [[slnc 380]] и покажи что изменилось",
     "проверь репозиторий и покажи что изменилось"),
    ("wake-pause", 185, "открой последние логи", "открой последние логи"),
    ("timer", 185, "поставь таймер на пять минут", "поставь таймер на пять минут"),
    ("letter", 155, "напиши короткое письмо команде", "напиши короткое письмо команде"),
    ("switch", 185, "переключись на прошлую сессию", "переключись на прошлую сессию"),
]
ONSET_HOLDOUT = [
    ("save", "сохрани заметку"),
    ("read", "прочитай последний комментарий"),
    ("what", "что изменилось в репозитории"),
    ("cancel", "жми отмену"),
]
ONSET_SHORT = [
    ("stop", "стоп"),
    ("yes", "да"),
    ("up", "вверх"),
]


def words(text):
    return re.findall(r"[а-яa-z0-9]+", text.lower().replace("ё", "е"))


def edits(ref, hyp):
    row = list(range(len(hyp) + 1))
    for i, lhs in enumerate(ref, 1):
        new = [i]
        for j, rhs in enumerate(hyp, 1):
            new.append(min(new[-1] + 1, row[j] + 1, row[j - 1] + (lhs != rhs)))
        row = new
    return row[-1]


def clean(raw):
    return " ".join(re.sub(r"\([^)]*\)", " ", re.sub(r"\[[^\]]*\]", " ", raw)).split())


def write_wav(path, pcm):
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        out.writeframes(pcm)


def read_wav(path):
    with wave.open(str(path)) as inp:
        if (inp.getnchannels(), inp.getsampwidth(), inp.getframerate()) != (1, 2, RATE):
            raise ValueError(f"Unexpected format: {path}")
        return inp.readframes(inp.getnframes())


def fixture(path, text, rate):
    spoken = path.with_name("say.wav")
    subprocess.run(SANDBOX + ["/usr/bin/say", "-v", "Milena", "-r", str(rate), "-o", spoken,
                              "--file-format=WAVE", "--data-format=LEI16@16000", text],
                   cwd=path.parent, check=True, timeout=30, stdin=subprocess.DEVNULL)
    pcm = read_wav(spoken)
    if not any(pcm):
        raise ValueError(f"No TTS audio for {path.name}")
    write_wav(path, bytes(PAD * 2) + pcm + bytes(int(RATE * 1.25) * 2))


def noise(kind, seconds=3):
    rng = random.Random(9301)
    return array("h", (int(
        500 * math.sin(2 * math.pi * 50 * i / RATE)
        + rng.uniform(-1, 1) * (350 + (2500 * math.exp(-(i % 7319) / 80) if kind == "clicks" else 0))
    ) if kind != "silence" else 0 for i in range(RATE * seconds))).tobytes()


def run(argv, cwd, env, replay=False):
    start = time.monotonic()
    # Native wake treats closed stdin as cancellation. Keep control open until WAV EOF.
    with tempfile.TemporaryFile(dir=cwd) as out, tempfile.TemporaryFile(dir=cwd) as err:
        with subprocess.Popen(SANDBOX + argv, cwd=cwd, env=env,
                              stdin=subprocess.PIPE if replay else subprocess.DEVNULL,
                              stdout=out, stderr=err) as proc:
            try:
                code = proc.wait(timeout=45)
            except subprocess.TimeoutExpired:
                proc.kill()
                raise
        out.seek(0)
        err.seek(0)
        raw, log = out.read().decode().strip(), err.read().decode(errors="replace")
    if code != 0 or any(line.lstrip().lower().startswith("error:") for line in log.splitlines()):
        raise RuntimeError(f"{argv[0]} ({code}): {log[-2000:]}")
    return raw, round((time.monotonic() - start) * 1000)


def summary(rows):
    for group in dict.fromkeys(row["group"] for row in rows):
        for engine in ("whisper", "gigaam"):
            match = [r for r in rows if (r["group"], r["engine"]) == (group, engine)]
            speech = [r for r in match if r["ref"]]
            negative = [r for r in match if not r["ref"]]
            n = sum(len(words(r["ref"])) for r in speech)
            errors = sum(r["edits"] for r in speech)
            emit(kind="summary", group=group, engine=engine, clips=len(match),
                 edits=errors, ref_words=n, wer=round(errors / n, 4) if n else None,
                 exact=sum(r["edits"] == 0 for r in speech), speech=len(speech),
                 negative=len(negative), raw_nonempty=sum(bool(r["raw"]) for r in negative),
                 cleaned_nonempty=sum(bool(r["text"]) for r in negative),
                 median_ms=statistics.median(r["ms"] for r in match),
                 heard=sum(r.get("heard", 0) for r in match))


def emit(**row):
    print(json.dumps(row, ensure_ascii=False), flush=True)


def engines(args):
    return [
        ("whisper", "whisper.cpp", "RAGE_WHISPER", args.whisper, args.whisper_model),
        ("gigaam", "transcribe-cpp", "OPENCODE_VOICE_TRANSCRIBE_CPP", args.gigaam, args.gigaam_model),
    ]


def decode(engine, wav, cwd, env):
    _, name, _, exe, model = engine
    flags = (["-m", model, "-f", wav, "-np", "-nt", "-l", "ru"] if name == "whisper.cpp"
             else ["--model", model, "--file", wav, "--language", "ru"])
    return run([exe, *flags], cwd, env)


def frication_runs(pcm, hit, min_crossings):
    samples = array("h", pcm)
    # Mark bursts on untouched audio, on the same frame grid but independently
    # of native cropping. A unique nearby burst is a proxy, not a word label.
    flags = []
    for pos in range(0, len(samples) - FRAME + 1, FRAME):
        frame = samples[pos:pos + FRAME]
        crossings = sum((a < 0) != (b < 0) for a, b in zip(frame, frame[1:]))
        flags.append(crossings >= min_crossings and sum(x * x for x in frame) >= 180**2 * FRAME)
    return [(m.start() * 10, m.end() * 10) for m in re.finditer("1{2,}", "".join(str(int(f)) for f in flags))
            if m.start() * 10 <= hit + 100 and m.end() * 10 >= hit - 100]


def onset(args, cwd, env):
    source = Path(__file__).with_name("wake-corpus-driver.rs").resolve()
    driver = cwd / "detect"
    rustc = shutil.which("rustc")
    if rustc is None:
        raise RuntimeError("--onset requires rustc for the standalone detector driver")
    subprocess.run(SANDBOX + [rustc, "--edition=2024", "-O", source, "-o", driver], cwd=cwd,
                   env=env, check=True, timeout=45)
    proxy = cwd / "capture-decoder"
    proxy.write_text('#!/bin/sh\n/bin/cat > "$QA_CAPTURE" || exit 1\n/bin/echo qa\n')
    proxy.chmod(0o700)
    cases = []
    for split, rates, commands in (("probe", (135, 155, 190), [(c[0], c[3]) for c in COMMANDS[:4]]),
                                   ("holdout", (145, 180), ONSET_HOLDOUT),
                                   ("short", (145, 180), ONSET_SHORT)):
        for rate in rates:
            for label, ref in commands:
                wav = cwd / f"{label}-{rate}.wav"
                fixture(wav, "Рейдж " + ref, rate)
                cases.append((split, label, rate, wav, ref))

    def measure(case):
        split, label, rate, wav, ref = case
        raw = read_wav(wav)
        pcm_file = wav.with_suffix(".pcm")
        pcm_file.write_bytes(raw)
        hits, _ = run([driver, "detect", pcm_file], cwd, env)
        found = [int(hit) for hit in hits.splitlines()]
        capture = wav.with_suffix(".capture.wav")
        output, _ = run([args.listen, "listen", "--wav", wav, "ru", args.whisper_model], cwd,
                        dict(env, RAGE_ENGINE="whisper.cpp", RAGE_WHISPER=str(proxy),
                             QA_CAPTURE=str(capture)), replay=True)
        heard = sum(json.loads(line)["event"] == "heard" for line in output.splitlines())
        info = dict(split=split, label=label, rate=rate, heard=heard, hits_ms=found, ref=ref)
        if not capture.exists():
            return dict(info, variants={})
        if len(found) != 1 or heard != 1:
            raise RuntimeError(f"Ambiguous hit in {wav.name}: driver={found}, listen={heard}")
        captured = read_wav(capture)
        if captured[:PAD * 2] != bytes(PAD * 2) or len(captured) < PAD * 2 + FRAME * 2:
            raise RuntimeError(f"Missing pad or command in {wav.name}")
        command = captured[PAD * 2:]
        start = raw.find(command)
        if start < 0 or start % (FRAME * 2) or raw.find(command, start + 1) >= 0:
            raise RuntimeError(f"Native crop did not uniquely match source frames in {wav.name}")
        hit = found[0]
        spans = frication_runs(raw, hit, 45)
        relaxed = frication_runs(raw, hit, 25) if not spans else spans
        burst_end = spans[0][1] if len(spans) == 1 else None
        relaxed_end = relaxed[0][1] if len(relaxed) == 1 else None
        end = start + len(command)
        variants = {"native": capture, "full": wav.with_suffix(".full.wav")}
        write_wav(variants["full"], raw[:end])
        cuts = [("hit+60", hit + 60), ("burst-end-fallback", relaxed_end)]
        if split == "probe":
            cuts.extend((("hit", hit), ("burst-end", burst_end)))
        for variant, cut in cuts:
            if cut is not None:
                path = wav.with_suffix(f".{variant}.wav")
                write_wav(path, bytes(PAD * 2) + raw[cut * RATE // 500:end])
                variants[variant] = path
        return dict(info, native_ms=start * 500 // RATE, frication_ms=spans, burst_end_ms=burst_end,
                    fallback_frication_ms=relaxed, fallback_end_ms=relaxed_end,
                    hit_minus_fallback_end_ms=hit - relaxed_end if relaxed_end is not None else None,
                    variants=variants)

    rows = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        measures = list(pool.map(measure, cases))
    for i, measure in enumerate(measures):
        variants = measure.pop("variants")
        emit(kind="onset-timing", **measure)
        used_preroll = bool(variants) and measure["native_ms"] == measure["hits_ms"][0] - 100
        hybrid = {
            "fallback-only+60": "hit+60" if used_preroll else "native",
            "fallback-only-burst": "burst-end-fallback" if used_preroll and
            "burst-end-fallback" in variants else "native",
        }
        for variant, wav in variants.items():
            ref = measure["ref"]
            expected = ("Рейдж " if variant == "full" else "") + ref
            position = int(variant == "full")
            for engine in engines(args)[::(-1 if i % 2 else 1)]:
                raw, _ = decode(engine, wav, cwd, env)
                got = words(clean(raw))
                row = dict(split=measure["split"], label=measure["label"], rate=measure["rate"],
                           variant=variant, engine=engine[0],
                           ref=expected, raw=raw, edits=edits(words(expected), got),
                           first_ok=got[position:position + 1] == words(ref)[:1],
                           wake_exact=got[:1] == ["рейдж"] if position else None)
                rows.append(row)
                emit(kind="onset-clip", **row)
                rows.extend(dict(row, variant=name) for name, selection in hybrid.items()
                            if selection == variant)
    for split, variant in dict.fromkeys((row["split"], row["variant"]) for row in rows):
        for engine, *_ in engines(args):
            pair = [r for r in rows if (r["split"], r["variant"], r["engine"]) == (split, variant, engine)]
            emit(kind="onset-summary", split=split, variant=variant, engine=engine, clips=len(pair),
                 exact=sum(r["edits"] == 0 for r in pair), edits=sum(r["edits"] for r in pair),
                 ref_words=sum(len(words(r["ref"])) for r in pair),
                 first_ok=sum(r["first_ok"] for r in pair),
                 wake_exact=sum(r["wake_exact"] for r in pair) if variant == "full" else None)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cache = Path.home() / ".cache/opencode-voice"
    cli.add_argument("--whisper", type=Path, default=cache / "engines/whisper.cpp/darwin-arm64/whisper-cli")
    cli.add_argument("--whisper-model", type=Path, default=cache / "models/ggml-large-v3-turbo-q5_0.bin")
    cli.add_argument("--gigaam", type=Path,
                     default=cache / "engines/transcribe-cpp/darwin-arm64/opencode-voice-transcribe")
    cli.add_argument("--gigaam-model", type=Path,
                     default=cache / "models/gigaam-v3-e2e-ctc-Q4_K_M.gguf")
    cli.add_argument("--listen", type=Path, help="Optional prebuilt rage-core for offline WAV replay")
    cli.add_argument("--onset", action="store_true", help="Compare actual and alternative crops; requires --listen")
    cli.add_argument("--tmp", type=Path, help="Existing directory for temporary fixtures")
    args = cli.parse_args()
    if args.onset and not args.listen:
        cli.error("--onset requires --listen")
    for name in ("whisper", "whisper_model", "gigaam", "gigaam_model", "listen"):
        path = getattr(args, name)
        if path is not None:
            if not path.is_file():
                cli.error(f"Not a file: {path}; supply --{name.replace('_', '-')}")
            setattr(args, name, path.resolve(strict=True))
    assert edits(words("Открой репо"), words("открой!")) == 1
    assert edits(words("Рейдж глянь"), words("рейс глянь там")) == 2
    assert clean("[музыка] (тишина)") == ""

    emit(kind="config", voice="Milena", language="ru", whisper_model=args.whisper_model.name,
         gigaam_model=args.gigaam_model.name, network="denied by sandbox-exec",
         replay=args.listen is not None, onset=args.onset, cleanup=False)
    rows = []
    with tempfile.TemporaryDirectory(prefix="wake-asr-", dir=args.tmp) as tmp:
        cwd = Path(tmp)
        env = dict(os.environ, TMPDIR=tmp, RAGE_FFMPEG="", RAGE_CLEANUP_FILTER="")
        env.pop("RAGE_WAKE_PROFILE", None)
        env.pop("RAGE_MODEL", None)
        if args.onset:
            onset(args, cwd, env)
            return
        cases = []
        for label, rate, script, ref in COMMANDS:
            prefix = "Рейдж [[slnc 450]] " if label == "wake-pause" else "Рейдж "
            for group, say_text, expected in (("bare", script, ref), ("full", prefix + script, "Рейдж " + ref)):
                wav = cwd / f"{label}-{group}.wav"
                fixture(wav, say_text, rate)
                cases.append((group, label, wav, expected))
        for label in ("silence", "hum", "clicks"):
            wav = cwd / f"{label}.wav"
            write_wav(wav, noise(label))
            cases.append(("noise", label, wav, ""))
        if args.listen:
            for group, label, wav, ref in cases[:]:
                if group == "noise" or (group == "full" and label in
                                        ("neurons", "networks", "settings", "repo", "clause-pause", "wake-pause")):
                    cases.append(("listen", label, wav, ref.removeprefix("Рейдж ")))
        for i, (group, label, wav, ref) in enumerate(cases):
            for spec in engines(args)[::(-1 if i % 2 else 1)]:
                engine, engine_id, key, exe, model = spec
                if group == "listen":
                    output, ms = run([args.listen, "listen", "--wav", wav, "ru", model], cwd,
                                     dict(env, RAGE_ENGINE=engine_id, **{key: str(exe)}), replay=True)
                    events = [json.loads(line) for line in output.splitlines()]
                    heard = sum(e["event"] == "heard" for e in events)
                    raw = text = " ".join(e["text"] for e in events if e["event"] == "text")
                else:
                    raw, ms = decode(spec, wav, cwd, env)
                    text, heard = clean(raw), None
                row = dict(group=group, label=label, engine=engine, ref=ref, raw=raw, text=text, ms=ms,
                           edits=edits(words(ref), words(text)) if ref else None)
                if heard is not None:
                    row["heard"] = heard
                rows.append(row)
                emit(kind="clip", **row)
        summary(rows)


if __name__ == "__main__":
    main()
