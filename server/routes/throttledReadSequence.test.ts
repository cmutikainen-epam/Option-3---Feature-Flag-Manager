import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import type { Request } from "express";
import type { FeatureFlag } from "../../shared/types.js";
import { failureTag } from "./test-helpers.js";

vi.mock("../db.js", () => ({
  getFlagByNameThrottledSequence: vi.fn(),
}));

import * as db from "../db.js";
import { throttledReadSequence } from "./throttledReadSequence.js";

const flag: FeatureFlag = {
  id: 1,
  name: "my-flag",
  enabled: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
};

const reqWithName = (name: unknown): Request => ({ query: { name } }) as unknown as Request;

describe("throttledReadSequence", () => {
  it("fails with BadRequestError when `name` is missing", async () => {
    const exit = await Effect.runPromiseExit(throttledReadSequence(reqWithName(undefined)));

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with BadRequestError when `name` is blank", async () => {
    const exit = await Effect.runPromiseExit(throttledReadSequence(reqWithName("   ")));

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with UnknownFlagError when the flag does not exist", async () => {
    vi.mocked(db.getFlagByNameThrottledSequence).mockReturnValue(Effect.succeed(null));

    const exit = await Effect.runPromiseExit(throttledReadSequence(reqWithName("missing")));

    expect(failureTag(exit)).toBe("UnknownFlagError");
  });

  describe("BEGIN/sleep/COMMIT sequence", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns the flag's enabled value read at the start of the transaction", async () => {
      vi.mocked(db.getFlagByNameThrottledSequence).mockReturnValue(Effect.succeed(flag));

      const exitPromise = Effect.runPromiseExit(throttledReadSequence(reqWithName("my-flag")));
      await vi.advanceTimersByTimeAsync(10_000);
      const exit = await exitPromise;

      expect(Exit.isSuccess(exit) && exit.value).toBe(true);
    });
  });
});
