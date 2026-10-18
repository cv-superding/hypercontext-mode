import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = new URL(".", import.meta.url);
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => fileURLToPath(new URL(name, dir)));

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
