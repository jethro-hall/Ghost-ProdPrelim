import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const sourceDir = resolve(rootDir, "node_modules", "@pdftron", "webviewer", "public");
const targetDir = resolve(rootDir, "public", "lib", "webviewer");

if (!existsSync(sourceDir)) {
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

for (const folder of ["core", "ui"]) {
  cpSync(resolve(sourceDir, folder), resolve(targetDir, folder), {
    recursive: true,
    force: true,
  });
}
