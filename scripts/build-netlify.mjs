import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssets } from "./assets.mjs";
const destination = fileURLToPath(new URL("../public/", import.meta.url));
await rm(destination, { recursive: true, force: true });
const { output, version } = await buildAssets();
for (const [file, bytes] of output) {
  const target = path.join(destination, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
console.log("Static build " + version + " · explicit asset manifest only");
