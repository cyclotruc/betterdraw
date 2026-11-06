// One server per database. Two processes would each keep their own copy of an open canvas in memory
// and overwrite each other's edits, so the second one refuses to start.
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isSqlite, pgPool, sqliteFile } from "./db.js";

const HEARTBEAT_MS = 10_000;

export async function acquireLock(): Promise<() => void> {
  if (!isSqlite) {
    // An advisory lock lives as long as the connection that took it: keep one connection for that.
    const client = await pgPool.connect();
    const [{ ok }] = (await client.query(`select pg_try_advisory_lock(727274801) as ok`)).rows;
    if (!ok) {
      client.release();
      throw new Error("Another server is already using this database. Stop it first.");
    }
    return () => client.release();
  }
  // SQLite: a lock file next to the database, refreshed every few seconds. A fresh file written by a
  // live process (or by another machine sharing the volume) means someone else is running.
  const file = sqliteFile + ".lock";
  if (existsSync(file)) {
    const [pid, host] = readFileSync(file, "utf8").split("@");
    const fresh = Date.now() - statSync(file).mtimeMs < HEARTBEAT_MS * 3;
    const sameHost = host === hostname();
    const alive = sameHost && Number(pid) !== process.pid && isAlive(Number(pid));
    if ((sameHost && alive) || (!sameHost && fresh))
      throw new Error(
        `Another server (pid ${pid} on ${host}) is already using ${sqliteFile}. Stop it first, or delete ${file} if it is not running.`,
      );
  }
  writeFileSync(file, `${process.pid}@${hostname()}`);
  const timer = setInterval(() => {
    try {
      utimesSync(file, new Date(), new Date());
    } catch {}
  }, HEARTBEAT_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      rmSync(file);
    } catch {}
  };
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}
