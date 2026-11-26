import type { InputLevel, ListenEvent } from "../rage/core.ts";

export type WakePhase = "starting" | "waiting" | "heard" | "stopping";
export type WakeMode = "listen" | "auto";
type Listen = (emit: (frame: ListenEvent) => void, signal: AbortSignal) => Promise<void>;
type DraftState = "empty" | "nonempty" | "stale" | "wait";
type Draft = {
  nonemptyAtBind: boolean;
  insert: (text: string) => "inserted" | "stale" | "wait";
  inspect: () => DraftState;
  append: (text: string) => void;
  release: () => void;
};
type Take = { draft: Draft; draftOnly: boolean };

// A take only belongs to the listener generation and composer that heard the hit.
export function createWakeListener(host: {
  sessionID: () => string | undefined;
  bindDraft: (sessionID: string) => Draft | undefined;
  idle: (sessionID: string) => boolean;
  send: (
    sessionID: string,
    text: string,
    signal: AbortSignal,
  ) => Promise<"rejected" | "accepted" | "unknown">;
  wait: (sessionID: string, signal: AbortSignal) => Promise<void>;
  phase: (phase?: WakePhase, level?: InputLevel, mode?: WakeMode) => void;
  error: (error: unknown) => void;
}) {
  let job: { abort: AbortController; done: Promise<void>; mode: WakeMode } | undefined;
  let origin: string | undefined;
  const pending = new Set<Take & { text: string }>();
  let armed: Take | undefined;
  let sending = false;

  function remove(entry: Take & { text: string }) {
    pending.delete(entry);
    entry.draft.release();
  }

  function disarm() {
    armed?.draft.release();
    armed = undefined;
  }

  function invalidateDraft(sessionID: string | undefined, all = true) {
    if (sessionID !== origin) return;
    // An inbox admission (including our own) does not replace an empty composer.
    if (all || job?.mode !== "auto" || armed?.draftOnly) disarm();
    for (const entry of pending) {
      if (all || job?.mode !== "auto" || entry.draftOnly) remove(entry);
    }
  }

  function stop() {
    invalidateDraft(origin);
    origin = undefined;
    if (job) {
      host.phase("stopping", undefined, job.mode);
      job.abort.abort();
    }
    return job?.done;
  }

  function sync() {
    if (!origin) return;
    if (host.sessionID() !== origin) {
      void stop();
      return;
    }
    if (job?.mode !== "auto") {
      for (const entry of pending) {
        if (entry.draft.insert(entry.text + " ") !== "wait") remove(entry);
      }
      return;
    }
    for (const entry of pending) {
      const state = entry.draft.inspect();
      if (state === "stale") {
        remove(entry);
        continue;
      }
      if (state === "wait") return;
      if (entry.draftOnly || state === "nonempty") {
        pending.delete(entry);
        entry.draft.append(entry.text);
        entry.draft.release();
        continue;
      }
      if (sending || !host.idle(origin)) return;
      sending = true;
      void send(origin, entry, job.abort.signal);
      return;
    }
  }

  async function send(sessionID: string, entry: Take & { text: string }, signal: AbortSignal) {
    const current = () => !signal.aborted && origin === sessionID && host.sessionID() === sessionID;
    // Remove before dispatch: re-entrant events and repeated final frames cannot resend this take.
    pending.delete(entry);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.draft.release();
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      const result = await host.send(sessionID, entry.text, signal);
      if (!current()) return;
      if (result === "rejected") {
        const rest = [...pending];
        pending.clear();
        entry.draftOnly = true;
        pending.add(entry);
        for (const next of rest) pending.add(next);
      } else {
        // POST acknowledges admission, not completion. Bridge the gap before the
        // next turn is reflected in the reactive TUI session status.
        await host.wait(sessionID, signal);
      }
    } catch (error) {
      if (current()) {
        host.error(error);
        void stop();
      }
    } finally {
      signal.removeEventListener("abort", release);
      if (!pending.has(entry)) release();
      sending = false;
      sync();
    }
  }

  function start(sessionID: string, mode: WakeMode, listen: Listen) {
    if (job || host.sessionID() !== sessionID) return;
    if (origin !== sessionID || mode === "auto") invalidateDraft(origin);
    origin = sessionID;
    const abort = new AbortController();
    let lastID = 0;
    let waiting = false;
    host.phase("starting", undefined, mode);
    const done = Promise.resolve()
      .then(() => {
        sync();
        if (abort.signal.aborted) return;
        return listen((frame) => {
          if (job?.abort !== abort || abort.signal.aborted) return;
          if (origin !== host.sessionID()) {
            void stop();
            return;
          }
          if (frame.event === "waiting") {
            waiting = true;
            disarm();
            host.phase("waiting", undefined, mode);
          } else if (frame.event === "level") {
            if (waiting) host.phase("waiting", frame.level, mode);
          } else if (frame.event === "heard" && frame.id > lastID) {
            waiting = false;
            lastID = frame.id;
            disarm();
            const draft = host.bindDraft(sessionID);
            if (draft) armed = { draft, draftOnly: draft.nonemptyAtBind };
            host.phase("heard", undefined, mode);
          } else if (frame.event === "text" && armed && frame.id === lastID) {
            if (frame.text.trim()) pending.add({ ...armed, text: frame.text.trim() });
            else armed.draft.release();
            armed = undefined;
            sync();
          }
        }, abort.signal);
      })
      .catch((error) => {
        if (!abort.signal.aborted && origin === host.sessionID()) host.error(error);
        invalidateDraft(origin);
      })
      .finally(() => {
        if (mode === "auto") {
          invalidateDraft(origin);
          abort.abort();
        }
        job = undefined;
        disarm();
        if (!pending.size) origin = undefined;
        host.phase();
      });
    job = { abort, done, mode };
  }

  return { start, stop, sync, invalidateDraft, busy: () => job?.mode };
}
