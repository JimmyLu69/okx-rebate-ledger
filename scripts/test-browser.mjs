import { spawn } from "node:child_process";
// Each test owns an isolated browser profile with synthetic history and keys.
for (const file of ["storage-browser.mjs", "profile-browser.mjs", "cache-browser.mjs", "pwa-smoke.mjs"]) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../tests/" + file, import.meta.url).pathname], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(Error(`${file} failed (${code})`)));
  });
}
