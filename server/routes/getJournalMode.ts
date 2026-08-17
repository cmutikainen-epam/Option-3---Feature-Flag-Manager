import type { Request } from "express";
import { Effect } from "effect";
import * as db from "../db.js";
import type { DbError } from "../../shared/errors.js";

/** GET /api/journal-mode — retrieve the current SQLite journal mode. */
export const getJournalMode = (
  _req: Request,
): Effect.Effect<string, DbError> =>
  db.getJournalMode();
