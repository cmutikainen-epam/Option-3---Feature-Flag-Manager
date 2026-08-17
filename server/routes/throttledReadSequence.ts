import type { Request } from "express";
import { Effect } from "effect";
import * as db from "../db.js";
import { BadRequestError, UnknownFlagError, type DbError } from "../../shared/errors.js";

/**
 * GET /api/flags/throttled-read-sequence — check whether a named flag is on,
 * reading it inside an explicit BEGIN/COMMIT sequence: BEGIN, read the flag,
 * sleep 10 seconds with the transaction still open, then COMMIT. An unknown
 * flag is a 422. Demonstrates that the read snapshot is fixed as of BEGIN,
 * regardless of writes committed elsewhere during the sleep.
 */
export const throttledReadSequence = (
  req: Request,
): Effect.Effect<boolean, BadRequestError | UnknownFlagError | DbError> =>
  Effect.gen(function* () {
    const name = req.query.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`name\` query parameter must be a non-empty string, received ${JSON.stringify(name)}`,
        }),
      );
    }

    const flag = yield* db.getFlagByNameThrottledSequence(name.trim());
    if (!flag) {
      return yield* Effect.fail(new UnknownFlagError({ message: `Flag ${name} not found` }));
    }

    return flag.enabled;
  });
