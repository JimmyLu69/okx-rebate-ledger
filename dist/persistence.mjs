// Coalesce frequent updates; at most one write plus one latest pending snapshot.
export function createSaver(write, delay = 700) {
  let timer,
    pending = new Map(),
    running = null,
    failure;
  async function drain() {
    if (running) return running;
    clearTimeout(timer);
    running = (async () => {
      while (pending.size) {
        const entries = [...pending];
        pending.clear();
        for (const [key, getSnapshot] of entries) {
          try {
            await write(key, getSnapshot());
            failure = null;
          } catch (error) {
            failure = error;
            throw error;
          }
        }
      }
    })().finally(() => {
      running = null;
      if (pending.size) schedule();
    });
    return running;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => drain().catch(() => {}), delay);
  }
  return {
    queue(key, getSnapshot) {
      pending.set(key, getSnapshot);
      if (!running) schedule();
    },
    async flush() {
      await drain();
      if (pending.size) await drain();
      if (failure) throw failure;
    },
    get pending() {
      return pending.size;
    },
    get error() {
      return failure;
    },
  };
}
