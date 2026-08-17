import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import type { Request } from "express";
import { ConflictError, DbError, UnknownFlagError } from "../../shared/errors.js";
import type { FeatureFlag } from "../../shared/types.js";
import { failureTag } from "./test-helpers.js";

vi.mock("../db.js", () => ({
  setFlagEnabled: vi.fn(),
}));

import * as db from "../db.js";
import { updateFlag } from "./updateFlag.js";

const flag: FeatureFlag = {
  id: 1,
  name: "my-flag",
  enabled: true,
  version: 2,
  createdAt: "2026-01-01T00:00:00Z",
};

const req = (params: unknown, body: unknown, query: unknown = {}): Request =>
  ({ params, body, query }) as unknown as Request;

afterEach(() => {
  vi.clearAllMocks();
});

describe("updateFlag", () => {
  it("updates the flag", async () => {
    vi.mocked(db.setFlagEnabled).mockReturnValue(Effect.succeed(flag));

    const exit = await Effect.runPromiseExit(
      updateFlag(req({ id: "1" }, { enabled: true, version: 1 })),
    );

    expect(Exit.isSuccess(exit) && exit.value).toEqual(flag);
    expect(db.setFlagEnabled).toHaveBeenCalledWith(1, true, 1);
  });

  it("fails with BadRequestError when `id` is not an integer", async () => {
    const exit = await Effect.runPromiseExit(
      updateFlag(req({ id: "not-a-number" }, { enabled: true, version: 1 })),
    );

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with BadRequestError when `enabled` is not a boolean", async () => {
    const exit = await Effect.runPromiseExit(
      updateFlag(req({ id: "1" }, { enabled: "yes", version: 1 })),
    );

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with BadRequestError when `version` is not an integer", async () => {
    const exit = await Effect.runPromiseExit(
      updateFlag(req({ id: "1" }, { enabled: true, version: "1" })),
    );

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with UnknownFlagError when the flag does not exist", async () => {
    vi.mocked(db.setFlagEnabled).mockReturnValue(
      Effect.fail(new UnknownFlagError({ message: "not found" })),
    );

    const exit = await Effect.runPromiseExit(
      updateFlag(req({ id: "1" }, { enabled: true, version: 1 })),
    );

    expect(failureTag(exit)).toBe("UnknownFlagError");
  });

  it("fails with ConflictError when the version is stale", async () => {
    vi.mocked(db.setFlagEnabled).mockReturnValue(
      Effect.fail(new ConflictError({ message: "stale version" })),
    );

    const exit = await Effect.runPromiseExit(
      updateFlag(req({ id: "1" }, { enabled: true, version: 1 })),
    );

    expect(failureTag(exit)).toBe("ConflictError");
  });

  it("fails with DbError when the db layer fails", async () => {
    vi.mocked(db.setFlagEnabled).mockReturnValue(Effect.fail(new DbError({ message: "boom" })));

    const exit = await Effect.runPromiseExit(
      updateFlag(req({ id: "1" }, { enabled: true, version: 1 })),
    );

    expect(failureTag(exit)).toBe("DbError");
  });

  describe("?throttled=true", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("updates the flag via setFlagEnabled, then delays the response", async () => {
      vi.mocked(db.setFlagEnabled).mockReturnValue(Effect.succeed(flag));

      const exitPromise = Effect.runPromiseExit(
        updateFlag(req({ id: "1" }, { enabled: true, version: 1 }, { throttled: "true" })),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const exit = await exitPromise;

      expect(Exit.isSuccess(exit) && exit.value).toEqual(flag);
      expect(db.setFlagEnabled).toHaveBeenCalledWith(1, true, 1);
    });

    it("fails with ConflictError when the version is stale, without waiting for the delay", async () => {
      vi.mocked(db.setFlagEnabled).mockReturnValue(
        Effect.fail(new ConflictError({ message: "stale version" })),
      );

      const exit = await Effect.runPromiseExit(
        updateFlag(req({ id: "1" }, { enabled: true, version: 1 }, { throttled: "true" })),
      );

      expect(failureTag(exit)).toBe("ConflictError");
    });
  });
});
