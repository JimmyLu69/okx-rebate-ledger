import { backupFilename } from "./ui-helpers.mjs";

export function createBackupController({ getContext, applySettings, previewHistory, applyAllowlist, getRecovery, prepareStoredExport, download, toast, onBusy }) {
  const $ = id => document.getElementById(id);
  let busy = false, worker, rejectWork, selectedFile;
  function status(text = "", error = false) {
    $(error ? "backupError" : "backupProgress").textContent = text;
    if (error) $("backupError").hidden = !text;
  }
  function cancel() {
    if (!busy) return;
    worker?.terminate();
    rejectWork?.(Error("已取消文件处理，原数据未改变"));
  }
  async function work(message) {
    if (busy) throw Error("请等待当前文件处理完成，或先取消");
    busy = true; onBusy(true); status("正在处理文件…"); status("", true);
    $("cancelBackup").hidden = false;
    worker = new Worker(new URL("./backup-worker.mjs", import.meta.url), { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        rejectWork = reject;
        worker.onmessage = ({ data }) => {
          if (data.type === "progress") return status(data.message || ({ read: "读取文件", parse: "解析文件", validate: "检查记录", decrypt: "解密备份", encrypt: "加密备份", serialize: "整理记录", compress: "压缩文件", readSaved: "读取已保存历史" }[data.phase] || "正在处理文件") + (data.bytes ? ` · ${(data.bytes / 1024 / 1024).toFixed(1)} MiB` : "") + "…");
          if (data.ok) resolve(data);
          else reject(Object.assign(Error(data.error), { code: data.code }));
        };
        worker.onerror = event => reject(Error(event.message || "文件处理意外中断"));
        worker.postMessage(message);
      });
    } finally {
      worker?.terminate(); worker = null; rejectWork = null;
      busy = false; onBusy(false); $("cancelBackup").hidden = true; status("");
    }
  }
  function failure(error) {
    status(error.message || "文件处理失败", true);
    $("retryImport").hidden = !selectedFile;
    if (error.code === "PASSWORD_REQUIRED" || /口令/.test(error.message)) {
      $("backupPassword").focus();
      $("backupPassword").setAttribute("aria-invalid", "true");
    }
    toast(error.message);
  }
  async function exportBackup(kind) {
    if (busy) return toast("请等待文件处理完成");
    onBusy(true);
    try {
      const context = getContext(), include = kind === "settings" && $("includeCredentials").checked,
        password = $("backupPassword").value;
      if (include && password.length < 8) throw Error("包含 API 凭证的备份必须加密，请填写至少 8 个字符的口令");
      if (password && password.length < 8) throw Error("加密口令至少 8 个字符");
      // In-memory export must remain available even if durable storage has failed.
      const value = kind === "history" ? {
        format: "rebate-history", backupVersion: 2, createdAt: new Date().toISOString(),
        wallets: context.wallets, state: context.state,
      } : {
        format: "rebate-settings", version: 1, wallets: context.wallets,
        preferences: context.preferences, selected: context.state.selected,
        assetAllowlist: context.assetAllowlist, credentialMode: context.credentialMode,
        scanOptions: context.scanOptions, ...(include ? { credentials: context.keys } : {}),
      };
      if (kind === "history" && context.protected) throw Error("历史读取异常，请先导出原始数据，避免把空账本当成历史备份");
      const compress = kind === "history" && $("compressBackup").checked;
      const stored = kind === "history" && await prepareStoredExport?.();
      // A freshly migrated localStorage ledger may not have an IndexedDB snapshot yet.
      // Its in-memory data remains the source until a successful save is confirmed.
      const { blob } = await work(stored ? { type: "encodeStored", wallets: context.wallets, password, compress } : { type: "encode", value, password, compress });
      download(backupFilename(kind === "history" ? "历史" : "设置", context.wallets, { credentials: include, password, compress }), blob);
      const message = kind === "history" ? `已导出 ${context.state.records.length.toLocaleString()} 条记录${context.unsaved ? "（含尚未保存到本机的进度）" : ""}` : include ? "加密设置已导出，包含 API 凭证" : "设置已导出";
      status(message); toast(message);
    } catch (error) { failure(error); }
    finally { onBusy(false); }
  }
  async function importFile(file, kind = "auto") {
    if (!file) return;
    selectedFile = { file, kind };
    try {
      const owner = getContext();
      if (owner.busy) throw Error("请先暂停查询任务");
      const result = await work({ type: "decode", file, kind, password: $("backupPassword").value, wallets: owner.wallets });
      if (getContext().busy || JSON.stringify(owner.wallets) !== JSON.stringify(getContext().wallets)) throw Error("钱包或任务状态已改变，请重新导入");
      const detected = result.kind || (result.value.format === "rebate-settings" ? "settings" : result.value.format === "rebate-allowlist" ? "allowlist" : "history");
      if (detected === "history") await previewHistory(result.value);
      else if (detected === "settings") applySettings(result.value);
      else applyAllowlist(result.value);
      $("retryImport").hidden = true; $("backupPassword").removeAttribute("aria-invalid");
      status(""); selectedFile = null;
    } catch (error) { failure(error); }
  }
  $("cancelBackup").onclick = cancel;
  $("retryImport").onclick = () => selectedFile && importFile(selectedFile.file, selectedFile.kind);
  $("exportRecovery").onclick = async () => {
    try {
      const context = getContext(), value = await getRecovery();
      download(backupFilename("原始数据救援", context.wallets), JSON.stringify(value));
      toast("原始数据已导出，请保留此文件后再恢复历史");
    } catch (error) { failure(error); }
  };
  for (const [id, kind] of [["importFile", "auto"], ["importSettings", "settings"], ["importAllowlist", "allowlist"]]) {
    $(id).onchange = event => { const file = event.target.files[0]; event.target.value = ""; importFile(file, kind); };
  }
  $("backupCenter").addEventListener("cancel", event => { if (busy) { event.preventDefault(); toast("文件处理中，可先点击取消"); } });
  $("backupCenter").querySelector("form").addEventListener("submit", event => { if (busy) { event.preventDefault(); toast("文件处理中，可先点击取消"); } });
  return { exportBackup, importFile, cancel, get busy() { return busy; } };
}
