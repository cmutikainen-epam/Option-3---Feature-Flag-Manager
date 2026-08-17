// Error types shared between the API server and the web client. Unlike
// shared/types.d.ts, this is a real module: these are runtime Schema.TaggedError
// classes (constructed with `new X(...)` and matched on `._tag`), not just
// wire-format shapes, so they can't be erased at build time. Being schema classes,
// they can also be encoded/decoded (e.g. over the wire) instead of just
// constructed locally.
import { Schema } from "effect";

const commonErrorFields = {
  message: Schema.String,
};

/** A client-side failure: bad or missing input. */
export class BadRequestError extends Schema.TaggedError<BadRequestError>()(
  "BadRequestError",
  commonErrorFields,
) {
  readonly httpStatus = 400;
}

/** A flag with the given name does not exist (404). */
export class UnknownFlagError extends Schema.TaggedError<UnknownFlagError>()(
  "UnknownFlagError",
  commonErrorFields,
) {
  readonly httpStatus = 404;
}

/** The flag version is stale; the update was not applied (409). */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "ConflictError",
  commonErrorFields,
) {
  readonly httpStatus = 409;
}

/** A flag with the given name already exists (422). */
export class DuplicateFlagError extends Schema.TaggedError<DuplicateFlagError>()(
  "DuplicateFlagError",
  commonErrorFields,
) {
  readonly httpStatus = 422;
}

/** Any failure originating from the SQLite layer (500). */
export class DbError extends Schema.TaggedError<DbError>()("DbError", commonErrorFields) {
  readonly httpStatus = 500;
}

/** Errors a route may fail with, mapped to HTTP responses by `errorResponse`. */
export type ApiError =
  BadRequestError | UnknownFlagError | ConflictError | DuplicateFlagError | DbError;

/**
 * Schema for `ApiError`, used to encode an error onto the wire (server) and
 * decode it back into the matching tagged class (client), so the client can
 * pattern-match on `_tag` instead of a stringified status code.
 */
export const ApiErrorSchema = Schema.Union(
  BadRequestError,
  UnknownFlagError,
  ConflictError,
  DuplicateFlagError,
  DbError,
);
