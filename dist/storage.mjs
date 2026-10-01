let database;
const versions = new Map(),
  revisions = new Map(),
  queues = new Map();
async function db() {
  return (database ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("rebate-ledger", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("wallets"))
        d.createObjectStore("wallets");
      if (!d.objectStoreNames.contains("records")) {
        const s = d.createObjectStore("records", { keyPath: ["wallet", "id"] });
        s.createIndex("wallet", "wallet");
      }
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => {
        r.result.close();
        database = null;
      };
      resolve(r.result);
    };
    r.onerror = () => {
      database = null;
      reject(r.error);
    };
    r.onblocked = () => reject(Error("请关闭其他旧版账本页面后重试"));
  }));
}
export async function readHistory(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(["wallets", "records"]),
      r = t.objectStore("wallets").get(key);
    let result,
      legacy = false,
      revision = 0;
    r.onsuccess = () => {
      const meta = r.result;
      if (!meta) {
        result = null;
        return;
      }
      revision = meta.storageRevision || 0;
      if (meta.storageVersion !== 2) {
        legacy = true;
        result = meta;
        return;
      }
      const rows = t.objectStore("records").index("wallet").getAll(key);
      rows.onsuccess = () => {
        const { storageVersion, storageRevision, ...state } = meta;
        result = { ...state, records: rows.result.map((r) => r.value) };
      };
    };
    t.oncomplete = () => {
      revisions.set(key, revision);
      if (result)
        versions.set(
          key,
          legacy
            ? new Map()
            : new Map(result.records.map((r) => [r.id, JSON.stringify(r)])),
        );
      resolve(result);
    };
    t.onerror = t.onabort = () => reject(t.error || Error("历史读取失败"));
  });
}
// Changed records, deletions and their cursor commit in one transaction. A second
// tab cannot silently replace a newer snapshot with this tab's stale state.
export function writeHistory(key, value) {
  const { records, ...rest } = value,
    meta = structuredClone(rest),
    snapshot = new Map(records.map((r) => [r.id, JSON.stringify(r)]));
  const task = (queues.get(key) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const d = await db();
      if (!versions.has(key)) {
        await readHistory(key);
        if (!versions.has(key)) versions.set(key, new Map());
      }
      const prior = versions.get(key),
        expected = revisions.get(key) || 0;
      return new Promise((resolve, reject) => {
        const t = d.transaction(["wallets", "records"], "readwrite"),
          wallets = t.objectStore("wallets"),
          rows = t.objectStore("records"),
          check = wallets.get(key);
        let failure;
        check.onsuccess = () => {
          try {
            if ((check.result?.storageRevision || 0) !== expected)
              throw Error(
                "另一个页面已更新此钱包；请导出当前记录后刷新，避免覆盖较新的历史",
              );
            for (const [id, json] of snapshot)
              if (prior.get(id) !== json)
                rows.put({ wallet: key, id, value: JSON.parse(json) });
            for (const id of prior.keys())
              if (!snapshot.has(id)) rows.delete([key, id]);
            wallets.put(
              { ...meta, storageVersion: 2, storageRevision: expected + 1 },
              key,
            );
          } catch (e) {
            failure = e;
            t.abort();
          }
        };
        t.oncomplete = () => {
          versions.set(key, snapshot);
          revisions.set(key, expected + 1);
          resolve();
        };
        t.onerror = t.onabort = () =>
          reject(failure || t.error || Error("保存中断"));
      });
    });
  queues.set(key, task);
  task
    .finally(() => {
      if (queues.get(key) === task) queues.delete(key);
    })
    .catch(() => {});
  return task;
}
export async function storageDiagnostics() {
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  return {
    usage: estimate?.usage ?? null,
    quota: estimate?.quota ?? null,
    pendingWalletWrites: queues.size,
  };
}
