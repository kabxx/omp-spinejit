import { execFileSync } from "node:child_process";
import { accessSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = new URL("../", import.meta.url);

// These package-owned release inputs must exist; compilation never supplies them.
for (const asset of ["spine.toml", "LICENSE"]) {
  accessSync(new URL(asset, packageRoot));
}

rmSync(new URL("dist/", packageRoot), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
  cwd: fileURLToPath(packageRoot),
  stdio: "inherit",
});
