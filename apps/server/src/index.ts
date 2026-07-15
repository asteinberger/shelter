import fs from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Database } from "./lib/database.js";
import { DeploymentWorker } from "./services/worker.js";

const config = loadConfig();
fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.sourcesDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.workspacesDir, { recursive: true, mode: 0o700 });

const role = process.argv[2] ?? process.env.PROCESS_ROLE ?? "api";

if (role === "worker") {
  const database = new Database(config);
  const worker = new DeploymentWorker(config, database);
  const stop = (): void => worker.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await worker.run();
  } finally {
    database.close();
  }
} else if (role === "api") {
  const app = await createApp(config);
  await app.listen({ host: config.HOST, port: config.PORT });
} else {
  throw new Error(`Unknown process role: ${role}`);
}
