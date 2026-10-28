import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiBase = String(process.env.TAZAMA_API_BASE || "").replace(/\/+$/, "");

if (apiBase) {
  const parsed = new URL(apiBase);
  if (parsed.protocol !== "https:" || parsed.origin !== apiBase) {
    throw new Error("TAZAMA_API_BASE must be an HTTPS origin without a path, for example https://your-service.onrender.com.");
  }
}

const publishDirectory = path.join(root, "dist");
await fs.rm(publishDirectory, { recursive: true, force: true });
await fs.cp(path.join(root, "public"), publishDirectory, { recursive: true });
await fs.writeFile(
  path.join(publishDirectory, "runtime-config.js"),
  `globalThis.TAZAMA_API_BASE = ${JSON.stringify(apiBase)};\n`,
  "utf8",
);
