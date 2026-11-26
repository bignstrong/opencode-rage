"""Interactive, local wake-word enrollment for the Mac test launcher."""
import argparse
import array
import fcntl
import json
import math
import os
from pathlib import Path
import select
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import wave


def training_folder():
    if os.environ.get("RAGE_SAVE_TAKES") != "0":
        return os.environ.get("RAGE_TRAINING_DIR")
    return None


def capture(ffmpeg, mic, prompt, seconds, role="enrollment"):
    input(f'\n«{prompt}» — нажми Enter и дождись начала записи. ')
    cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
           "-f", "avfoundation", "-i", mic, "-vn", "-ac", "1", "-ar", "16000",
           "-t", str(seconds), "-c:a", "pcm_s16le", "-f", "s16le", "-flush_packets", "1", "pipe:1"]
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=0) as proc:
        pcm = bytearray()
        try:
            deadline = time.monotonic() + seconds + 10
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([proc.stdout], [], [], remaining)[0]:
                    raise OSError("Микрофон не передал звук вовремя. Проверь разрешение для Terminal.")
                block = os.read(proc.stdout.fileno(), 8192)
                if not block:
                    break
                if not pcm:
                    cue = "Сейчас тишина, ничего не говори" if prompt == "помолчи" else f"Говори: {prompt}"
                    print(f"{cue}  [запись {seconds} с]", flush=True)
                pcm.extend(block)
            if proc.wait(timeout=2) or len(pcm) < 16000:
                raise OSError("Нет звука с выбранного микрофона.")
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            print("Запись остановлена.", flush=True)
    if folder := training_folder():
        from training_data import save_calibration
        save_calibration(Path(folder), pcm, prompt, role)
    return bytes(pcm)


def levels(pcm):
    samples = array.array("h", pcm)
    energies = [math.sqrt(sum(v*v for v in samples[i:i+160]) / 160)
                for i in range(0, len(samples)-159, 160)]
    if not energies:
        raise ValueError("Запись пустая.")
    floor = sorted(energies)[len(energies)//5]
    peak = max(energies)
    db = lambda x: round(20 * math.log10(max(1, x) / 32768), 1)
    return energies, max(64, floor*3, peak*0.025), {
        "peak_rms_dbfs": db(peak), "floor_rms_dbfs": db(floor),
        "clipped_percent": round(100 * sum(abs(v) >= 32760 for v in samples) / len(samples), 2)}


def bounds(energies, gate, max_frames):
    # A keyboard click can precede otherwise clean speech. Ignore isolated impulses.
    groups = []
    for i, energy in enumerate(energies):
        if energy >= gate:
            if not groups or i - groups[-1][-1] > 10:
                groups.append([])
            groups[-1].append(i)
    groups = [g for g in groups if len(g) >= 4]
    if not groups:
        raise ValueError("Не отличил голос от фона. Проверь выбранный вход и уровень сигнала.")
    start, end = groups[0][0], groups[-1][-1] + 1
    if not 15 <= end-start <= max_frames:
        raise ValueError(f"Сигнал занял {(end-start)*10} мс; ожидаю 150–{max_frames*10} мс. "
                         "После «Говори» произнеси только подсказку.")
    return start, end


def save_wav(path, pcm):
    temp = path.with_suffix(".part")
    with wave.open(str(temp), "wb") as out:
        out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        out.writeframes(pcm)
    temp.replace(path)


def select_name(pcm, profile, tmp):
    energies, gate, stats = levels(pcm)
    start, end = bounds(energies, gate, 390)
    print(level_text(stats))
    durations = []
    for n in range(1, 5):
        with wave.open(str(profile / f"{n}.wav"), "rb") as f:
            durations.append(f.getnframes() // 160)
    lo, hi = 15, min(150, end-start-15)
    if hi < lo:
        raise ValueError("Фраза слишком короткая. Скажи имя и команду слитно.")
    length = min(hi, max(lo, int(statistics.median(durations)) - 6))
    preview = tmp / "preview.wav"
    try:
        while True:
            clip = pcm[max(0, start-3)*320:(start+length)*320]
            save_wav(preview, clip)
            subprocess.run(["/usr/bin/afplay", preview], check=True)
            action = input(f"Прослушано {length*10} мс. Только целое «Рейдж»? "
                           "Enter: принять; +/−: добавить/убрать 30 мс; р: записать ещё раз. ").strip().lower()
            if not action:
                return clip
            if action == "р":
                raise ValueError("Запишем эту фразу ещё раз.")
            if action in ("+", "-", "−"):
                length = min(hi, max(lo, length + (3 if action == "+" else -3)))
    finally:
        if preview.exists():
            preview.unlink()


def detect(driver, raw, profile, pcm):
    raw.write_bytes(pcm)
    try:
        result = subprocess.run([driver, "detect", raw, profile], capture_output=True, text=True)
        if result.returncode:
            raise ValueError("Профиль не принят: " + result.stderr.strip())
        return [int(line) for line in result.stdout.splitlines()]
    finally:
        raw.unlink()


def level_text(stats):
    return (f"пик {stats['peak_rms_dbfs']} дБFS, фон {stats['floor_rms_dbfs']} дБFS, "
            f"перегрузка {stats['clipped_percent']}%")


def crosscheck(driver, tmp, profile):
    subset = tmp / "subset"
    subset.mkdir()
    for path in profile.glob("*.wav"):
        os.link(path, subset / path.name)
    results = {}
    for path in sorted(profile.glob("*.wav")):
        if path.name.startswith("reject-"):
            continue
        link = subset / path.name
        link.unlink()
        with wave.open(str(path), "rb") as f:
            pcm = f.readframes(f.getnframes())
        hits = detect(driver, tmp / "probe.pcm", subset, bytes(6400) + pcm + bytes(9600))
        results[path.stem] = len(hits)
        os.link(path, link)
    return results


def enroll(ffmpeg, mic, base):
    os.umask(0o077)
    if folder := training_folder():
        from training_data import private_root
        private_root(Path(folder))
    base.mkdir(parents=True, exist_ok=True)
    with (base / ".calibration.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Уже открыта другая калибровка.")
        run_checks(ffmpeg, mic, base)


def run_checks(ffmpeg, mic, base):
    profile = base / "pending"
    fluent = False
    if profile.exists():
        previous_mic = (profile / "mic.txt").read_text() if (profile / "mic.txt").exists() else ""
        answer = input(f"Есть сохранённые образцы ({previous_mic.lstrip(':')}). "
                       "Enter: продолжить, «фразы»: заменить образцы 5 и 6 в слитной речи с прослушиванием, "
                       "«заново»: записать новый набор. ").strip().lower()
        if answer == "заново":
            profile.replace(Path(tempfile.mkdtemp(prefix="previous-", dir=base)))
        elif previous_mic != mic:
            raise ValueError("Для другого входа выбери «заново». Старые образцы останутся на Mac.")
        elif answer == "фразы":
            fluent = True
        elif answer:
            raise ValueError("Выбор не распознан. Образцы сохранены.")
    profile.mkdir(exist_ok=True)
    (profile / "mic.txt").write_text(mic)
    folder = training_folder()
    storage = (f"Завершённые записи и контрольные пробы сохраняются в {folder}."
               if folder else
               "На Mac сохраняются образцы для профиля пробуждения. Контрольные записи удаляются; остаётся отчёт с числами.")
    print(f"Микрофон: {mic.lstrip(':')}. Уровень показывается после каждой записи.\n{storage}"
          "\nCtrl+C останавливает мастер. Уже принятые образцы можно использовать в следующий раз.")
    source = Path(__file__).resolve().parents[1] / "rust/qa/wake-corpus-driver.rs"
    with tempfile.TemporaryDirectory(dir=base) as scratch:
        tmp = Path(scratch)
        driver = tmp / "detector"
        subprocess.run(["rustc", "--edition=2024", "-O", source, "-o", driver], check=True)
        for n, word in enumerate(["Рейдж"]*6 + ["рейс", "речь"], 1):
            path = profile / f"{'reject-' if n > 6 else ''}{n}.wav"
            if n == 5 and not fluent and not path.exists():
                answer = input("Для образцов 5 и 6 введи «фразы», чтобы записать слитную речь и "
                               "выбрать конец имени на слух. Enter: ещё два отдельных слова. ").strip().lower()
                if answer not in ("", "фразы"):
                    raise ValueError("Выбор не распознан. Образцы сохранены.")
                fluent = answer == "фразы"
            contextual = fluent and n in (5, 6)
            if path.is_file() and not contextual:
                continue
            if contextual:
                word = "Рейдж закажи билет" if n == 5 else "Рейдж разбуди меня"
            while True:
                try:
                    if contextual:
                        spoken = capture(ffmpeg, mic, word, 4)
                        save_wav(path, select_name(spoken, profile, tmp))
                        break
                    pcm = capture(ffmpeg, mic, word, 3)
                    energies, gate, stats = levels(pcm)
                    print(level_text(stats))
                    start, end = bounds(energies, gate, 150)
                    save_wav(path, pcm[max(0, start-3)*320:(end+3)*320])
                    break
                except ValueError as e:
                    print(e)
            print(f"Сохранено {n}/8.")

        # Verify unseen speech with the same Rust detector that consumes the live stream.
        raw = tmp / "check.pcm"
        detect(driver, raw, profile, b"")
        training = crosscheck(driver, tmp, profile)
        print(f"Взаимная проверка образцов: {sum(n == 1 for n in training.values())}/{len(training)}. "
              "Каждый раз проверяю слово только по остальным образцам.")
        tests = [("Рейдж", 1), ("Рейдж открой настройки", 1), ("Рейдж дай прогноз", 1),
                 ("этот рейс задержали", 0), ("моя речь", 0), ("помолчи", 0)]
        report = {"mic": mic.lstrip(":"), "leave_one_out": training, "checks": []}
        report_path = base / "last-check.json"
        for prompt, expected in tests:
            row = {"prompt": prompt, "expected": expected, "passed": False}
            for _ in range(2):
                pcm = capture(ffmpeg, mic, prompt, 4, role="validation")
                energies, gate, stats = levels(pcm)
                row.update(stats)
                print(level_text(stats))
                try:
                    start = 0 if prompt == "помолчи" else bounds(energies, gate, 390)[0]
                except ValueError as e:
                    row["input_error"] = str(e)
                    print(e)
                    continue
                row.pop("input_error", None)
                hits = detect(driver, raw, profile, pcm)
                row.update(hits_ms=hits, onset_ms=start*10)
                row["passed"] = len(hits) == expected and (not expected or 0 <= hits[0]-start*10 <= 1500)
                print(f"{'Да' if row['passed'] else 'Нет'}: срабатываний {len(hits)}; ожидалось {expected}.")
                break
            report["checks"].append(row)
            staged = tmp / "report.json"
            staged.write_text(json.dumps(report, ensure_ascii=False, indent=2))
            staged.replace(report_path)
        failed = [r["prompt"] for r in report["checks"] if not r["passed"]]
        print(f"\nОтчёт без звука: {report_path}")
        if failed:
            if any("input_error" in r for r in report["checks"]):
                print("Часть записей не дала различимого голоса. Сначала проверь вход и указанный уровень фона.")
            elif "Рейдж" not in failed and any(p.startswith("Рейдж ") for p in failed):
                print("Отдельное имя узнал, в слитной команде пропустил. При следующем запуске "
                      "выбери «фразы»: заменятся только образцы 5 и 6.")
            if any(r.get("hits_ms") for r in report["checks"] if not r["expected"]):
                print("Есть ложное срабатывание без имени. Снижать порог по этому тесту нельзя.")
            raise ValueError("Не прошли: " + ", ".join(failed) +
                             ". Образцы сохранены. Активный профиль не изменён.")
        target = Path(tempfile.mkdtemp(prefix="voice-", dir=base))
        for path in profile.glob("*.wav"):
            shutil.copyfile(path, target / path.name)
        link = tmp / "current"
        link.symlink_to(target.name)
        link.replace(base/"current")
        print(f"Профиль проверен и включён: {target}")
        if sum(n == 1 for n in training.values()) * 2 < len(training):
            print("Контрольные фразы прошли, но меньше половины образцов узнаются по остальным. "
                  "В обычной речи имя может пропускаться. Образцы сохранены; повторять мастер не нужно.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ffmpeg")
    parser.add_argument("mic")
    parser.add_argument("base", type=Path)
    args = parser.parse_args()
    if not args.mic.startswith(":") or args.mic[1:] in ("", "default") or args.mic[1:].isdigit():
        parser.error("Выбери микрофон по имени в /rage-settings.")
    try:
        enroll(args.ffmpeg, args.mic, args.base)
    except (OSError, ValueError, EOFError, KeyboardInterrupt, subprocess.SubprocessError) as error:
        sys.exit(f"\nКалибровка остановлена. {error}")
