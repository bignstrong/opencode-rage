"""Review local Rage recordings. An ASR guess or a calibration prompt is never a label."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import uuid
import wave
from pathlib import Path


def private_root(root):
    if not root.is_absolute():
        raise ValueError("Для RAGE_TRAINING_DIR нужен абсолютный путь.")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError(f"Папка должна быть личной (права 700): {root}")
    return root


def write_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".json-", delete=False) as tmp:
        try:
            json.dump(value, tmp, ensure_ascii=False, indent=2)
            tmp.write("\n")
            tmp.close()
            os.replace(tmp.name, path)
        finally:
            Path(tmp.name).unlink(missing_ok=True)


def save_calibration(root, pcm, prompt, role):
    root = private_root(root)
    with tempfile.TemporaryDirectory(dir=root, prefix=".stage-") as tmp:
        # Rename the complete child so an interrupted write is never a reviewable item.
        record = Path(tmp) / uuid.uuid4().hex
        record.mkdir(mode=0o700)
        fd = os.open(record / "audio.wav", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as raw:
            with wave.open(raw, "wb") as out:
                out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                out.writeframes(pcm)
        write_json(record / "meta.json", {"source": "calibration", "role": role, "prompt": prompt,
                   "status": "recorded", "language": "ru", "asr_text": None, "reference_text": None})
        target = root / record.name
        record.rename(target)
        return target


def records(root):
    if not root.is_dir():
        return []
    paths = (p for p in private_root(root).iterdir() if not p.name.startswith(".")
             and p.is_dir() and not p.is_symlink() and (p / "meta.json").is_file()
             and (p / "audio.wav").is_file())
    return sorted(paths, key=lambda p: (p.joinpath("audio.wav").stat().st_mtime_ns, p.name), reverse=True)


def review(root):
    items = [p for p in records(root) if not (p / "reference.json").exists()]
    print(f"Без разметки: {len(items)}. Новые сверху.")
    for p in items:
        meta = json.loads((p / "meta.json").read_text())
        guess = meta.get("asr_text")
        print(f"\n{p.name} ({meta['source']}). Распознано: {guess or '—'}")
        if meta.get("prompt"):
            print("Подсказка мастера:", meta["prompt"])
        while True:
            action = input("Enter: слушать; ввести точный текст; =: подтвердить распознанное; "
                           "/тишина: речи нет; /пропуск; /выход. ").strip()
            if not action:
                subprocess.run(["/usr/bin/afplay", str(p / "audio.wav")], check=True)
                continue
            if action == "/выход":
                return
            if action == "/пропуск":
                break
            if action == "=" and not guess:
                print("Нет текста для подтверждения.")
                continue
            text = guess if action == "=" else "" if action == "/тишина" else action
            write_json(p / "reference.json", {"text": text})
            break


def manifest(root):
    for p in records(root):
        ref = p / "reference.json"
        if ref.is_file():
            meta = json.loads((p / "meta.json").read_text())
            print(json.dumps({"audio": str(p / "audio.wav"), "source": meta["source"],
                              "role": meta.get("role"), "text": json.loads(ref.read_text())["text"]},
                             ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("review", "manifest", "count"))
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "count":
            items = records(args.directory)
            print(f"Записей: {len(items)}; размечено: {sum((p/'reference.json').is_file() for p in items)}")
        else:
            (review if args.action == "review" else manifest)(args.directory)
    except (EOFError, KeyboardInterrupt):
        sys.exit(0)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
