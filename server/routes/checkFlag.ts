import type { Request } from "express";
import { Effect } from "effect";
import * as db from "../db.js";
import { BadRequestError, UnknownFlagError, type DbError } from "../../shared/errors.js";

export const checkFlag = (
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

    const flag = yield* db.getFlagByName(name.trim());
    if (!flag) {
      return yield* Effect.fail(new UnknownFlagError({ message: `Flag ${name} not found` }));
    }

    return flag.enabled;
  });
