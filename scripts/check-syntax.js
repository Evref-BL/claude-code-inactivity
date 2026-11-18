#!/usr/bin/env node
// Runs `node --check` on every .js file under src/ and scripts/.
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

let failed = 0;
for (const dir of ["src", "scripts"]) {
  for (const file of walk(join(root, dir))) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      failed += 1;
      console.error(result.stderr);
    }
  }
}
process.exitCode = failed ? 1 : 0;
