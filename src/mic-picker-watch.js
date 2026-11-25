// Each scan schedules the next only after it settles. Unmount aborts pending discovery.
export function watchMicrophones(list, changed, intervalMs = 2500) {
  const controller = new AbortController();
  let timer;
  let previous;
  async function scan() {
    let devices;
    try {
      devices = await list(controller.signal);
    } catch {
      // Discovery can time out while Continuity devices reconnect. Keep the last good list.
    }
    if (controller.signal.aborted) return;
    if (Array.isArray(devices)) {
      const snapshot = JSON.stringify(devices);
      if (snapshot !== previous) {
        previous = snapshot;
        changed(devices);
      }
    }
    if (!controller.signal.aborted) timer = setTimeout(scan, intervalMs);
  }
  void scan();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
