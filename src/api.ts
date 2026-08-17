import { Effect, Schema } from "effect";
import type { FeatureFlag } from "../shared/types.js";
import { ApiErrorSchema } from "../shared/errors.js";

const decodeApiError = Schema.decodeUnknownSync(ApiErrorSchema);

const request = <A>(input: RequestInfo, init?: RequestInit): Effect.Effect<A, string> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(input, init),
      catch: () => "Could not reach the server. Please check your connection and try again.",
    });
    const body: unknown = yield* Effect.tryPromise({
      try: () => res.json(),
      catch: () => "Could not decode JSON",
    });

    if (res.ok) {
      // TODO use schema validation on `A` so we dont have to cast
      return body as A;
    }

    return yield* decodeApiError(body);
  }).pipe(
    Effect.catchTags({
      BadRequestError: (error) => Effect.fail(error.message),
      UnknownFlagError: (error) => Effect.fail(error.message),
      ConflictError: () => Effect.fail("This flag changed elsewhere — refresh and try again."),
      DuplicateFlagError: (error) =>
        Effect.fail(`${error.message}. Please modify the name and try adding again`),
      DbError: () => Effect.fail("Could not reach Database, try again later"),
    }),
  );

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Fetch every feature flag. */
export const listFlags = (): Effect.Effect<readonly FeatureFlag[], string> =>
  request<readonly FeatureFlag[]>("/api/flags");

/** Check a flag value by name. `throttled` adds a 10-second delay before the lookup. */
export const getFlagByName = (name: string): Effect.Effect<boolean, string> =>
  request<boolean>(`/api/flags/check?name=${encodeURIComponent(name)}`);

/** Read a flag via BEGIN → read → sleep 10s → COMMIT. Returns the snapshot value read at BEGIN. */
export const getFlagByNameThrottledSequence = (name: string): Effect.Effect<boolean, string> =>
  request<boolean>(`/api/flags/throttled-read-sequence?name=${encodeURIComponent(name)}`);

/** Create a new feature flag with the given name (disabled by default). */
export const createFlag = (name: string): Effect.Effect<FeatureFlag, string> =>
  request<FeatureFlag>("/api/flags", jsonInit("POST", { name }));

/**
 * Enable or disable an existing flag. Requires the current version for
 * optimistic locking. `throttled` updates immediately but delays the
 * announce (and thus the response) by 10 seconds.
 */
export const setFlagEnabled = (
  id: number,
  enabled: boolean,
  version: number,
  throttled = false,
): Effect.Effect<FeatureFlag, string> =>
  request<FeatureFlag>(
    `/api/flags/${id}${throttled ? "?throttled=true" : ""}`,
    jsonInit("PATCH", { enabled, version }),
  );

/** Delete a feature flag by id. */
export const deleteFlag = (id: number): Effect.Effect<void, string> =>
  request<void>(`/api/flags/${id}`, { method: "DELETE" });
