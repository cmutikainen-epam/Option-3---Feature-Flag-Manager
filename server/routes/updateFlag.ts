import type { Request } from "express";
import { Effect } from "effect";
import * as db from "../db.js";
import {
  BadRequestError,
  type ConflictError,
  type DbError,
  type UnknownFlagError,
} from "../../shared/errors.js";
import type { FeatureFlag } from "../../shared/types.js";

/**
 * PATCH /api/flags/:id — enable or disable an existing flag, using optimistic
 * locking via `version`. `?throttled=true` updates immediately but delays
 * the announce (and thus the response) by 10 seconds.
 */
export const updateFlag = (
  req: Request,
): Effect.Effect<FeatureFlag, BadRequestError | UnknownFlagError | ConflictError | DbError> =>
  Effect.gen(function* () {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`id\` must be an integer, received "${req.params.id}"`,
        }),
      );
    }
    const body = req.body as { enabled?: unknown; version?: unknown };
    if (typeof body.enabled !== "boolean") {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`enabled\` must be a boolean for flag ${id}, received ${JSON.stringify(body.enabled)}`,
        }),
      );
    }
    if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `\`version\` must be a non-negative integer for flag ${id}, received ${JSON.stringify(body.version)}`,
        }),
      );
    }

    const updated = yield* db.setFlagEnabled(id, body.enabled, body.version);

    if (req.query.throttled === "true") {
      yield* Effect.sleep(10000);
    }

    return updated;
  });
