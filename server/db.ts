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

// WAL mode is enabled across all connections
db.pragma("journal_mode = WAL");

// better-sqlite3 defaults to a 5000ms busy timeout, and because it is
// synchronous a waiting writer blocks the *entire Node event loop* for that
// long. That starves the `Effect.sleep` timer that ends the read transaction in
// `getFlagByNameThrottledSequence`, so two blocked toggles are enough to burn
// through the 10s hold in wall-clock time; the reader then commits the instant
// the loop frees and the next toggle succeeds. Failing fast keeps the demo's
// timeline honest and each blocked write instant.
db.pragma("busy_timeout = 0");

/**
 * Open a second, independent connection for a single run of
 * {@link getFlagByNameThrottledSequence}.
 *
 * SQLite locks are held per connection, not per HTTP request. If the long read
 * transaction ran on the shared `db` handle, a concurrent write from another
 * tab would arrive on that same connection and simply join the open
 * transaction instead of contending with it — no lock conflict, nothing to
 * observe. Giving the reader its own connection makes it a genuine second
 * client, so writes on `db` really do block.
 *
 * It is deliberately per-request rather than a module-level handle. Leaving WAL
 * mode requires an exclusive lock on the database, which SQLite will not grant
 * while another connection is attached to the WAL — and a connection attaches
 * on its first read and stays attached for its lifetime. A long-lived reader
 * would therefore make {@link changeJournalMode}'s `WAL → DELETE` direction
 * fail with `SQLITE_BUSY` forever after the first demo run. Opening and closing
 * around each run also means an abandoned request cannot strand an open
 * transaction holding locks for the life of the process.
 */
const openReaderConnection = (): Database.Database => {
  const reader = new Database(DB_PATH);
  // The reader only ever takes SHARED, which is never blocked by another reader,
  // so it should never sit in a busy handler stalling the event loop either.
  reader.pragma("busy_timeout = 0");
  return reader;
};

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
 * Change the journal mode for the whole database.
 *
 * `journal_mode` is a property of the database *file*, not of a connection, so
 * one pragma converges every connection: existing handles pick the new mode up,
 * and connections opened later inherit it. There is nothing to fan out.
 *
 * `WAL → DELETE` needs an exclusive lock, so it fails with `SQLITE_BUSY` if a
 * {@link getFlagByNameThrottledSequence} run is holding its reader open — which
 * is honest, since a real second client has the database at that moment.
 */
export const changeJournalMode = ({ mode }: Record<'mode', string>): Effect.Effect<string, DbError> =>
  lookup(
    `changeJournalMode(mode=${mode})`,
    () => db.pragma(`journal_mode = ${mode}`, { simple: true }) as string,
  )

export const getJournalMode = (): Effect.Effect<string, DbError> =>
  lookup('getJournalMode()', () => {
    const journalModeResult = db.pragma('journal_mode', { simple: true })
    if (typeof journalModeResult === 'string') {
      return journalModeResult
    }

    throw new DbError({ message: 'Cannot read journal_mode' })
  })

/**
 * Hold a long read transaction open on a dedicated connection to show that, in
 * rollback-journal (DELETE) mode, a reader blocks writers.
 *
 * `BEGIN DEFERRED` takes no lock; the SELECT that follows acquires SHARED and
 * holds it until COMMIT. During the 10s sleep, a write arriving on the shared
 * `db` connection gets as far as RESERVED but cannot upgrade to EXCLUSIVE in
 * order to commit, so it fails with `SQLITE_BUSY`.
 *
 * `BEGIN EXCLUSIVE` would also block writers, but for the wrong reason — it
 * takes the write lock up front, so the writer fails on its first statement
 * rather than at commit time, which is not what a long *read* transaction does.
 *
 * The connection is acquired and released around the sequence, so it is closed
 * on success, on failure, *and* on interruption (a client that hangs up mid
 * sleep). Nothing survives the request to hold locks or the WAL open.
 */
export const getFlagByNameThrottledSequence = (
  name: string,
): Effect.Effect<FeatureFlag | null, DbError> =>
  Effect.acquireUseRelease(
    lookup(`throttledReadSequence(name="${name}") OPEN`, openReaderConnection),
    (reader) =>
      lookup(`throttledReadSequence(name="${name}") BEGIN`, () => {
        reader.exec("BEGIN DEFERRED");
      }).pipe(
        Effect.flatMap(() =>
          lookup(`throttledReadSequence(name="${name}") SELECT`, () => {
            // Takes the SHARED lock that blocks writers for the next 10 seconds.
            const row = reader
              .prepare<[string], FlagRow>(
                "SELECT id, name, enabled, version, createdAt FROM feature_flags WHERE name = ?",
              )
              .get(name);
            return row ? toFlag(row) : null;
          }),
        ),
        Effect.tap(() => Effect.sleep(10000)),
        Effect.tap(() =>
          lookup(`throttledReadSequence(name="${name}") COMMIT`, () => {
            reader.exec("COMMIT");
          }),
        ),
      ),
    (reader) =>
      // Release must never fail, so swallow anything the teardown throws — the
      // outcome of the sequence itself is already decided by this point.
      Effect.sync(() => {
        try {
          if (reader.inTransaction) reader.exec("ROLLBACK");
        } catch (cause) {
          console.log(`ROLLBACK ${name} failed:`, cause);
        } finally {
          reader.close();
        }
      }),
  );
