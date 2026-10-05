// Locks contain only public wallet addresses, never credentials or private history.
export async function acquireWalletTask(wallets, signal) {
  if (!globalThis.navigator?.locks) return () => {};
  const names = Object.entries(wallets).filter(([, value]) => value)
    .map(([chain, value]) => `rebate-task:${chain}:${value}`).sort();
  const releases = [];
  try {
    for (const name of names) {
      signal?.throwIfAborted();
      const release = await new Promise((resolve, reject) => {
        navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
          if (!lock) return reject(Error("另一个页面正在查询此钱包，请在该页面查看进度"));
          await new Promise(done => resolve(done));
        }).catch(reject);
      });
      releases.push(release);
    }
    signal?.throwIfAborted();
    return () => releases.splice(0).forEach(release => release());
  } catch (error) {
    releases.forEach(release => release());
    throw error;
  }
}
