import type { Request } from "express";
import { Effect } from "effect";
import * as db from "../db.js";
import { BadRequestError, type DbError, type UnknownFlagError } from "../../shared/errors.js";

/** DELETE /api/flags/:id — delete a feature flag by id. */
export const deleteFlag = (
  req: Request,
): Effect.Effect<null, BadRequestError | UnknownFlagError | DbError> =>
  Effect.gen(function* () {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`id\` must be an integer, received "${req.params.id}"`,
        }),
      );
    }
    yield* db.deleteFlag(id);
    return null;
  });
