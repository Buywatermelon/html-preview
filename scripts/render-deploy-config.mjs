import { readFileSync, writeFileSync } from "node:fs";

const out = process.argv[2];
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const admin = process.env.ADMIN_GITHUB_LOGIN || "";
const endpointPlaceholder = "https://example.r2.cloudflarestorage.com";
const adminPlaceholder = 'ADMIN_GITHUB_LOGIN = "replace-at-deploy"';

if (!out) {
  console.error("usage: node scripts/render-deploy-config.mjs <outfile>");
  process.exit(1);
}
if (!/^[0-9a-fA-F]{32}$/.test(account)) {
  console.error("CLOUDFLARE_ACCOUNT_ID must be 32 hex characters");
  process.exit(1);
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(admin)) {
  console.error("ADMIN_GITHUB_LOGIN must be a GitHub login");
  process.exit(1);
}

let text = readFileSync("wrangler.toml", "utf8");
if (!text.includes(endpointPlaceholder) || !text.includes(adminPlaceholder)) {
  console.error("wrangler.toml is missing deploy placeholders");
  process.exit(1);
}
text = text.replaceAll(
  endpointPlaceholder,
  `https://${account.toLowerCase()}.r2.cloudflarestorage.com`,
);
text = text.replaceAll(adminPlaceholder, `ADMIN_GITHUB_LOGIN = "${admin}"`);
if (text.includes(endpointPlaceholder) || text.includes("replace-at-deploy")) {
  console.error("deploy config still contains placeholders");
  process.exit(1);
}
writeFileSync(out, text);
