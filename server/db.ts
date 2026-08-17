import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { FlagsEventBus } from "./events.js";
import { ConflictError, DbError, DuplicateFlagError, UnknownFlagError } from "../shared/errors.js";

import type { FeatureFlag } from "../shared/types.js";

// Where the SQLite file lives. Overridable so Docker can mount a volume.
const DB_PATH = process.env.DATABASE_PATH ?? "data/app.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// Enable MVCC (Multi Version Concurrency Control)
// We dont want to block reads for clients checking value of a feature flag
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS feature_flags (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    enabled   INTEGER NOT NULL DEFAULT 0,
    version   INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
`);

// The on-disk shape. SQLite has no boolean type, so `enabled` is stored as an
// integer (0/1); `toFlag` maps a row to the public {@link FeatureFlag}.
interface FlagRow {
  readonly id: number;
  readonly name: string;
  readonly enabled: number; // SQLite has no boolean type, so `enabled` is stored as an integer {0, 1}
  readonly version: number;
  readonly createdAt: string;
}

const toFlag = (row: FlagRow): FeatureFlag => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled !== 0,
  version: row.version,
  createdAt: row.createdAt,
});

const selectByNameStmt = db.prepare<[string], FlagRow>(
  "SELECT id, name, enabled, version, createdAt FROM feature_flags WHERE name = ?",
);
const insertStmt = db.prepare<[string, number], FlagRow>(
  "INSERT INTO feature_flags (name, enabled) VALUES (?, ?)",
);
const selectAllStmt = db.prepare<[], FlagRow>(
  "SELECT id, name, enabled, version, createdAt FROM feature_flags ORDER BY id DESC",
);
const selectByIdStmt = db.prepare<[number], FlagRow>(
  "SELECT id, name, enabled, version, createdAt FROM feature_flags WHERE id = ?",
);
const updateEnabledStmt = db.prepare<[number, number, number], { readonly changes: number }>(
  "UPDATE feature_flags SET enabled = ?, version = version + 1 WHERE id = ? AND version = ?",
);
const deleteStmt = db.prepare<[number], { readonly changes: number }>(
  "DELETE FROM feature_flags WHERE id = ?",
);

/**
 * Run a synchronous better-sqlite3 call as an Effect, converting any thrown
 * error into a typed {@link DbError}. `operation` should already describe
 * the id/name/version being operated on so the resulting message is
 * concrete, e.g. `` `setFlagEnabled(id=5, version=2)` ``.
 */
const lookup = <A>(operation: string, run: () => A): Effect.Effect<A, DbError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new DbError({
        message: `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** Notify subscribers that the flags table changed. */
export const announceChange: Effect.Effect<void> = Effect.sync(() =>
  FlagsEventBus.emitTableChange(new Date()),
);

/** All feature flags, newest first. */
export const listFlags = (): Effect.Effect<FeatureFlag[], DbError> =>
  lookup("listFlags", () => selectAllStmt.all().map(toFlag));

/** Insert a flag and return the stored row. */
export const createFlag = (
  name: string,
  enabled = false,
): Effect.Effect<FeatureFlag, DuplicateFlagError | DbError> =>
  Effect.gen(function* () {
    const existing = yield* getFlagByName(name);
    if (existing) {
      return yield* Effect.fail(
        new DuplicateFlagError({ message: `A flag named "${name}" already exists` }),
      );
    }
    return yield* lookup(`createFlag(name="${name}")`, () => {
      const info = insertStmt.run(name, enabled ? 1 : 0);
      const row = selectByIdStmt.get(Number(info.lastInsertRowid));
      if (!row) {
        throw new Error(`Inserted flag ${info.lastInsertRowid} could not be read back`);
      }
      return toFlag(row);
    });
  });

/** Distinguish a missing id from a stale version after a no-op update. */
const updateMissError = (id: number): UnknownFlagError | ConflictError =>
  selectByIdStmt.get(id)
    ? new ConflictError({ message: `Flag version mismatch (id ${id})` })
    : new UnknownFlagError({ message: `Flag ${id} not found` });

/**
 * Toggle a flag's `enabled` state if the version matches.
 */
export const setFlagEnabled = (
  id: number,
  enabled: boolean,
  expectedVersion: number,
): Effect.Effect<FeatureFlag, UnknownFlagError | ConflictError | DbError> =>
  lookup(`setFlagEnabled(id=${id}, version=${expectedVersion})`, () => {
    const info = updateEnabledStmt.run(enabled ? 1 : 0, id, expectedVersion);
    if (info.changes === 0) return null;
    return selectByIdStmt.get(id) ?? null;
  }).pipe(
    Effect.flatMap((row) => (row ? Effect.succeed(toFlag(row)) : Effect.fail(updateMissError(id)))),
  );

/** Delete a flag by id. */
export const deleteFlag = (id: number): Effect.Effect<void, UnknownFlagError | DbError> =>
  lookup(`deleteFlag(id=${id})`, () => deleteStmt.run(id)).pipe(
    Effect.flatMap((info) =>
      info.changes === 0
        ? Effect.fail(new UnknownFlagError({ message: `Flag ${id} not found` }))
        : Effect.void,
    ),
  );

export const getFlagByName = (name: string): Effect.Effect<FeatureFlag | null, DbError> =>
  lookup(`getFlagByName(name="${name}")`, () => {
    const row = selectByNameStmt.get(name);
    return row ? toFlag(row) : null;
  });

/**
 * Read a flag by name inside an explicit transaction: BEGIN, read, sleep 10
 * seconds with the transaction still open, then COMMIT. The row is read
 * right after BEGIN, so it reflects a snapshot fixed at that moment —
 * demonstrating that the read is unaffected by writes committed elsewhere
 * while this transaction sleeps. Rolls back instead of committing if
 * anything fails partway through.
 */
export const getFlagByNameThrottledSequence = (
  name: string,
): Effect.Effect<FeatureFlag | null, DbError> =>
  lookup(`throttledReadSequence(name="${name}") BEGIN`, () => {
    db.exec("BEGIN");
  }).pipe(
    Effect.flatMap(() =>
      lookup(`throttledReadSequence(name="${name}") SELECT`, () => {
        const row = selectByNameStmt.get(name);
        return row ? toFlag(row) : null;
      }),
    ),
    Effect.tap(() => Effect.sleep(10000)),
    Effect.tap(() =>
      lookup(`throttledReadSequence(name="${name}") COMMIT`, () => {
        db.exec("COMMIT");
      }),
    ),
    Effect.catchAll((error) =>
      lookup(`throttledReadSequence(name="${name}") ROLLBACK`, () => {
        db.exec("ROLLBACK");
      }).pipe(Effect.flatMap(() => Effect.fail(error))),
    ),
  );
