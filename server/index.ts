// Boot: lock the database, migrate it, then serve HTTP and WebSockets on one port.
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { env } from "./env.js";
import { migrate } from "./db.js";
import { acquireLock } from "./lock.js";
import { start } from "./extend.js";

let release: () => void;
try {
  release = await acquireLock();
} catch (e: any) {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
}
await migrate(); // tables first: Better Auth checks them when it loads
if (!env.s3) await mkdir(env.filesDir, { recursive: true });

const { serve } = await import("@hono/node-server");
const { app } = await import("./app.js");
const { attachRealtime } = await import("./realtime.js");
const { startJobs } = await import("./jobs.js");
const { rooms } = await import("./rooms.js");
const { flushHits } = await import("./stats.js");

export const ready = new Promise<Server>((resolve) => {
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.bind }, () => resolve(server as Server)) as Server;
  server.on("error", (e: any) => {
    release();
    console.error(
      e.code === "EADDRINUSE" ? `\n  Port ${env.port} is already in use. Pick another one with PORT.\n` : `\n  ${e.message}\n`,
    );
    process.exit(1);
  });
  attachRealtime(server);
});
await ready;
console.log(`listening on http://${env.bind}:${env.port}`);
startJobs();
start();

// Write every open canvas before exiting.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all([...[...rooms.values()].map((r) => r.flush()), flushHits()]);
    release();
    process.exit(0);
  });
