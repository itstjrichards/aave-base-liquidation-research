import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "../config/config";

// Makes consistent, safe-to-open copies of the live SQLite databases.
//
// WHY THIS EXISTS: never open the live .db files from the host (sqlite3 CLI, a VS Code SQLite
// viewer, `npm run` scripts) while the container is running. The databases use WAL mode, which
// relies on shared memory and file locks that don't cross the Docker Desktop VM boundary, so a
// host session can't see the container's locks; when it closes it may checkpoint and delete the
// WAL out from under the container, corrupting the database (this happened to borrowers.db).
//
// Run this INSIDE the container, where the locks are shared, then open the copies on the host:
//   docker compose exec watcher node dist/scripts/snapshotDbs.js
// Copies land in data/snapshots/.

/** Copies one database to `data/snapshots/` using VACUUM INTO, which is safe alongside a live writer. */
function snapshot(dbPath: string): void {
  const outDir = path.join(path.dirname(dbPath), "snapshots");
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, path.basename(dbPath));
  // VACUUM INTO refuses to overwrite, so clear any previous snapshot (and its sidecar files) first.
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(target + suffix, { force: true });

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  console.log(`Snapshot written: ${target}`);
}

for (const dbPath of [config.dbPath, config.alertsDbPath, config.borrowersDbPath]) {
  snapshot(dbPath);
}
