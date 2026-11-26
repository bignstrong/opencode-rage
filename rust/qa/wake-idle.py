"""Measure the macOS --input path without AVFoundation, a microphone, network, or ASR.

python3 rust/qa/wake-idle.py --ffmpeg /path/to/ffmpeg [--unplug-wav synthetic-wake.wav]
"""
import argparse
from array import array
import ctypes as ct
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import select
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import wave

REPO = Path(__file__).resolve().parents[2]
MIB = 1024 ** 2
NOISE = "anoisesrc=color=pink:amplitude=0.012:sample_rate=48000:seed=741:nb_samples=480"

# A scan starts a real FFmpeg executable, but never passes it a device name or
# AVFoundation args. wait4 supplies its peak RSS even if a scan falls between samples.
SHIM = r"""
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int n, char **v) {
    const char *ff = getenv("QA_FFMPEG");
    FILE *log = fopen("events", "a");
    if (!log) return 80;
    for (int i=1; i<n; ++i) if (!strcmp(v[i], "-list_devices")) {
        fprintf(log, "scan %d\n", getpid()); fflush(log);
        fprintf(stderr, "AVFoundation audio devices:\n[0] Fixture  [uid:%s]\n",
                access("unplugged", F_OK) ? "pinned" : "replacement");
        pid_t kid = fork();
        if (!kid) { execl(ff, ff, "-version", NULL); _exit(81); }
        struct rusage child, self;
        int code;
        if (kid<0 || wait4(kid, &code, 0, &child)!=kid || !WIFEXITED(code) || WEXITSTATUS(code))
            return 82;
        if (getrusage(RUSAGE_SELF, &self)) return 83;
        fprintf(log, "scanned %d %ld %ld\n", getpid(), self.ru_maxrss, child.ru_maxrss);
        return 1;  // AVFoundation lists successfully and then rejects the empty input.
    }
    int pinned=0, pipe=0;
    for (int i=1; i+1<n; ++i)
        if (!strcmp(v[i], "-audio_device_id") && !strcmp(v[i+1],"uid:pinned")) pinned=1;
    if (n>1 && !strcmp(v[n-1],"pipe:1")) pipe=1;
    if (!pinned || !pipe) return 84;
    fprintf(log, "open %d\n", getpid()); fclose(log);
    fprintf(stderr, "[avfoundation @ 0x1] [verbose] audio device 'Fixture' opened\n");
    if (getenv("QA_UNPLUG"))
        execl(ff, ff, "-nostdin", "-v", "error", "-re", "-f", "s16le", "-ar", "16000",
              "-ac", "1", "-i", "unplug.pcm", "-f", "s16le", "-flush_packets", "1", "pipe:1", NULL);
    else
        execl(ff, ff, "-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i", getenv("QA_NOISE"),
              "-ar", "16000", "-ac", "1", "-f", "s16le", "-flush_packets", "1", "pipe:1", NULL);
    return 85;
}
"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


class Usage:
    # Darwin's rusage_info_v2 uses Mach absolute ticks, not nanoseconds on M2.
    def __init__(self):
        self.lib = ct.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        tb = (ct.c_uint32 * 2)()
        if ct.CDLL("/usr/lib/libSystem.B.dylib").mach_timebase_info(ct.byref(tb)):
            raise OSError("mach_timebase_info failed")
        self.tick = tb[0] / tb[1] * 1e-9

    def read(self, pid):
        # sys/resource.h: 16-byte UUID followed by 18 uint64_t fields.
        r = (ct.c_uint64 * 20)()
        if self.lib.proc_pid_rusage(pid, 2, ct.byref(r)):
            raise OSError(ct.get_errno(), f"proc_pid_rusage({pid})")
        return ((r[2] + r[3]) * self.tick, (r[12] + r[13]) * self.tick, r[8])


def rows(root, kind):
    return [s.split()[1:] for s in (root / "events").read_text().splitlines()
            if s.split() and s.split()[0] == kind]


def frame(proc, deadline):
    if not select.select([proc.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
        raise TimeoutError("missing listener event")
    line = proc.stdout.readline()
    require(line, f"listener exited ({proc.poll()})")
    return json.loads(line)


def meter(event):
    return (event.get("event") == "level" and type(event.get("level")) is int
            and 0 <= event["level"] <= 3)


def next_transition(proc, deadline):
    while True:
        event = frame(proc, deadline)
        if not meter(event):
            return event


def prepare_turn(root, wav):
    with wave.open(str(wav), "rb") as f:
        require((f.getnchannels(), f.getsampwidth(), f.getframerate()) == (1, 2, 16000),
                "expected synthetic mono 16kHz s16 WAV")
        pcm = array("h", f.readframes(f.getnframes()))
    end = max(i for i, x in enumerate(pcm) if abs(x) > 256)
    tail = array("h", (round(2400 * math.sin(i * math.tau * 311 / 16000))
                       for i in range(6 * 16000)))
    (root / "unplug.pcm").write_bytes(bytes(16000) + pcm[:end+1].tobytes() + tail.tobytes())


def trial(root, core, ff, seconds, unplug):
    (root / "events").write_text("")
    policy = ('(version 1)(allow default)(deny device-microphone)(deny network*)'
              '(deny file-write*)(allow file-write* (literal "/dev/null")'
              f'(literal {json.dumps(str(root / "events"))}))')
    env = dict(PATH="/usr/bin:/bin", HOME=str(root), TMPDIR=str(root),
               QA_FFMPEG=str(ff), QA_NOISE=NOISE, RAGE_FFMPEG=str(root/"shim"))
    if unplug:
        env["QA_UNPLUG"] = "1"
    args = ["/usr/bin/sandbox-exec", "-p", policy, str(core), "listen", "--input",
            ":uid:pinned:Fixture", "ru", "intentionally-no-model"]
    proc = subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
    try:
        require(frame(proc, time.monotonic()+8) == {"event": "waiting"}, "no waiting state")
        opens = rows(root, "open")
        require(len(opens) == 1, f"capture opens {opens}")
        capture = int(opens[0][0])
        if unplug:
            require(next_transition(proc, time.monotonic()+5) == {"event": "heard", "id": 1}, "no wake hit")
            started = time.monotonic()
            (root/"unplugged").touch()  # Same display name, replacement UID, active non-silent turn.
            proc.wait(timeout=4)
            err = proc.stderr.read().decode()
            require(proc.returncode != 0 and "Selected input lost" in err, err)
            result = dict(heardID=1, lossToExitMs=round((time.monotonic()-started)*1000),
                          exitCode=proc.returncode, error=err.strip())
        else:
            use = Usage()
            def sample():
                cpu, reaped, rss = use.read(proc.pid)
                ff_cpu, _, ff_rss = use.read(capture)
                return time.monotonic(), cpu, ff_cpu, reaped, rss + ff_rss
            first = sample()
            samples = [first[-1]]
            initial = len(rows(root, "scanned"))
            while True:
                time.sleep(.05)
                last = sample()
                samples.append(last[-1])
                elapsed = last[0] - first[0]
                require(elapsed < seconds + 3, "inventory scan did not finish")
                if elapsed >= seconds and len(rows(root, "scan")) == len(rows(root, "scanned")):
                    break
            scans = rows(root, "scanned")[initial:]
            require(len(scans) >= 5, "steady measurement missed rescans")
            cpu = [round(100 * (b-a)/elapsed, 4) for a,b in zip(first[1:4],last[1:4])]
            result = dict(seconds=round(elapsed, 3), samples=len(samples),
                          listenerCpuPct=cpu[0], captureCpuPct=cpu[1], reapedScanTreeCpuPct=cpu[2],
                          combinedCpuPct=round(sum(cpu), 4), steadyRescans=len(scans),
                          listenerPlusCaptureMedianRssMiB=round(statistics.median(samples)/MIB, 2),
                          listenerPlusCaptureMaxSampledRssMiB=round(max(samples)/MIB, 2),
                          extraConcurrentScanRssBoundMiB=math.ceil(max(int(a)+int(b) for _,a,b in scans)*100/MIB)/100)
            proc.stdin.close()
            proc.wait(timeout=4)
            require(proc.returncode == 0, f"failed to stop: {proc.returncode}")
        remaining = [json.loads(line) for line in proc.stdout]
        require(all(meter(event) for event in remaining), "unexpected text, rearm or extra event")
        require(len(rows(root, "open")) == 1, "listener opened a fallback")
        require(not list(root.rglob("*.wav")), "worker wrote a WAV")
        try:
            os.killpg(proc.pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise RuntimeError("listener left a descendant")
        return dict(**result, captureOpens=1, diskWavFiles=0)
    except BaseException:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        print(proc.stderr.read().decode(), file=sys.stderr)
        raise
    finally:
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            pipe.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ffmpeg", type=Path, required=True)
    ap.add_argument("--core", type=Path, default=REPO/"native/target/release/rage-core")
    ap.add_argument("--seconds", type=float, default=15.)
    ap.add_argument("--unplug-wav", type=Path, help="optional synthetic wake utterance for turn loss")
    args = ap.parse_args()
    require(platform.system() == "Darwin" and math.isfinite(args.seconds) and args.seconds >= 12,
            "requires Darwin and >=12 seconds")
    with tempfile.TemporaryDirectory(prefix="rage-wake-idle-") as work:
        root = Path(work).resolve()
        core = root/"listener"
        shutil.copy2(args.core, core)  # Freeze binary while another build may replace the target.
        ff = args.ffmpeg.resolve(strict=True)
        subprocess.run(["cc", "-O2", "-x", "c", "-", "-o", root/"shim"], input=SHIM, text=True, check=True)
        report = dict(chip=output("sysctl", "-n", "machdep.cpu.brand_string"),
                      macOS=platform.mac_ver()[0], coreSHA256=sha(core),
                      ffmpeg=output(ff, "-version").splitlines()[0], ffmpegSHA256=sha(ff),
                      source=NOISE, idle=trial(root, core, ff, args.seconds, False))
        if args.unplug_wav:
            prepare_turn(root, args.unplug_wav)
            report["unplug"] = trial(root, core, ff, args.seconds, True)
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
