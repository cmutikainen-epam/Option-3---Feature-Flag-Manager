import type { Request } from "express";
import { Effect } from "effect";
import * as db from "../db.js";
import { BadRequestError, type DbError, type DuplicateFlagError } from "../../shared/errors.js";
import type { FeatureFlag } from "../../shared/types.js";

/** POST /api/flags — create a new feature flag (disabled by default). */
export const createFlag = (
  req: Request,
): Effect.Effect<FeatureFlag, BadRequestError | DuplicateFlagError | DbError> =>
  Effect.gen(function* () {
    const body = req.body as { name?: unknown; enabled?: unknown };
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`name\` must be a non-empty string, received ${JSON.stringify(body.name)}`,
        }),
      );
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`enabled\` must be a boolean for flag "${body.name.trim()}", received ${JSON.stringify(body.enabled)}`,
        }),
      );
    }
    return yield* db.createFlag(body.name.trim(), body.enabled ?? false);
  });
