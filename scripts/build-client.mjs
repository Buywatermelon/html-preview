import { build } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  configFile: resolve(root, "vite.config.ts"),
  root,
});

const js = readFileSync(resolve(root, "dist/client/client.js"), "utf8");
const css = readFileSync(resolve(root, "dist/client/client.css"), "utf8");

const out = `export const CLIENT_JS = ${JSON.stringify(js)};\nexport const CLIENT_CSS = ${JSON.stringify(css)};\n`;

writeFileSync(resolve(root, "src/client-bundle.generated.ts"), out, "utf8");
console.log(
  `[build-client] Generated src/client-bundle.generated.ts (JS: ${(
    js.length / 1024
  ).toFixed(1)} KB, CSS: ${(css.length / 1024).toFixed(1)} KB)`
);
