import type { Request } from "express";
import { Effect } from "effect";
import * as db from "../db.js";
import { BadRequestError, type DbError } from "../../shared/errors.js";

/** PATCH /api/journal-mode — change the SQLite journal mode. */
export const changeJournalMode = (
  req: Request,
): Effect.Effect<string, BadRequestError | DbError> =>
  Effect.gen(function* () {
    const body = req.body as { mode?: unknown };
    if (typeof body.mode !== "string" || body.mode.trim().length === 0) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`mode\` must be a non-empty string, received ${JSON.stringify(body.mode)}`,
        }),
      );
    }
    return yield* db.changeJournalMode({ mode: body.mode.trim().toUpperCase() });
  });
