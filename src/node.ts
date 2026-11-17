import type { AuthConfig } from "./auth";
import { startNodePreviewServer } from "./node-server";
import { S3Store, type StorageConfig } from "./storage";

const config = process.env as unknown as StorageConfig & AuthConfig & { VAPID_PUBLIC_KEY?: string };
if (!config.PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL");

const store = new S3Store(config);
const srv = await startNodePreviewServer({
  ...config,
  port: Number(process.env.PORT) || 3000,
  host: "0.0.0.0",
  databasePath: process.env.DATABASE_PATH || "/data/html-preview.sqlite",
  store,
});

console.log("html-preview listening");

function shutdown() {
  void srv.close().then(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
