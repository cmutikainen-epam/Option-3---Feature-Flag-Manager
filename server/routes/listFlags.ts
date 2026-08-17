import { Effect } from "effect";
import * as db from "../db.js";
import type { FeatureFlag } from "../../shared/types.js";
import type { DbError } from "../../shared/errors.js";

/** GET /api/flags — every feature flag. */
export const listFlags = (): Effect.Effect<readonly FeatureFlag[], DbError> => db.listFlags();
