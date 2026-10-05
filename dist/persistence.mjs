// Coalesce frequent updates without discarding the last unsaved snapshot on quota errors.
export function createSaver(write, delay = 700) {
  let timer, pending = new Map(), running = null, failure;
  async function drain() {
    if (running) return running;
    clearTimeout(timer);
    running = (async () => {
      while (pending.size) {
        const entries = [...pending]; pending.clear();
        for (let index=0;index<entries.length;index++) {
          const [key,getSnapshot]=entries[index];
          try { await write(key,getSnapshot()); failure=null; }
          catch(error) {
            failure=error;
            // Preserve newer queued state if it arrived while this write was active.
            for(const [remaining,get]of entries.slice(index))if(!pending.has(remaining))pending.set(remaining,get);
            throw error;
          }
        }
      }
    })().finally(()=>{running=null;if(pending.size&&!failure)schedule()});
    return running;
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>drain().catch(()=>{}),delay)}
  return {
    queue(key,getSnapshot){pending.set(key,getSnapshot);if(!running)schedule()},
    async flush(){await drain();if(pending.size)await drain();if(failure)throw failure},
    // Export the in-memory state even when persistence is unavailable. This never
    // hides the write failure from callers that require a durable checkpoint.
    async flushForExport(){if(failure)return{saved:false,error:failure};try{await this.flush();return{saved:true,error:null}}catch(error){return{saved:false,error}}},
    get pending(){return pending.size},
    get error(){return failure},
  };
}
