import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import type { Request } from "express";
import type { FeatureFlag } from "../../shared/types.js";
import { failureTag } from "./test-helpers.js";

vi.mock("../db.js", () => ({
  getFlagByName: vi.fn(),
}));

import * as db from "../db.js";
import { checkFlag } from "./checkFlag.js";

const flag: FeatureFlag = {
  id: 1,
  name: "my-flag",
  enabled: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
};

const reqWithName = (name: unknown, throttled?: unknown): Request =>
  ({ query: { name, throttled } }) as unknown as Request;

describe("checkFlag", () => {
  it("returns the flag's enabled value", async () => {
    vi.mocked(db.getFlagByName).mockReturnValue(Effect.succeed(flag));

    const exit = await Effect.runPromiseExit(checkFlag(reqWithName("my-flag")));

    expect(Exit.isSuccess(exit) && exit.value).toBe(true);
  });

  it("fails with BadRequestError when `name` is missing", async () => {
    const exit = await Effect.runPromiseExit(checkFlag(reqWithName(undefined)));

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with BadRequestError when `name` is blank", async () => {
    const exit = await Effect.runPromiseExit(checkFlag(reqWithName("   ")));

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with UnknownFlagError when the flag does not exist", async () => {
    vi.mocked(db.getFlagByName).mockReturnValue(Effect.succeed(null));

    const exit = await Effect.runPromiseExit(checkFlag(reqWithName("missing")));

    expect(failureTag(exit)).toBe("UnknownFlagError");
  });

  describe("?throttled=true", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns the flag's enabled value after the delay", async () => {
      vi.mocked(db.getFlagByName).mockReturnValue(Effect.succeed(flag));

      const exitPromise = Effect.runPromiseExit(checkFlag(reqWithName("my-flag", "true")));
      await vi.advanceTimersByTimeAsync(10_000);
      const exit = await exitPromise;

      expect(Exit.isSuccess(exit) && exit.value).toBe(true);
    });

    it("fails with BadRequestError when `name` is missing, without waiting for the delay", async () => {
      const exit = await Effect.runPromiseExit(checkFlag(reqWithName(undefined, "true")));

      expect(failureTag(exit)).toBe("BadRequestError");
    });

    it("fails with UnknownFlagError when the flag does not exist", async () => {
      vi.mocked(db.getFlagByName).mockReturnValue(Effect.succeed(null));

      const exitPromise = Effect.runPromiseExit(checkFlag(reqWithName("missing", "true")));
      await vi.advanceTimersByTimeAsync(10_000);
      const exit = await exitPromise;

      expect(failureTag(exit)).toBe("UnknownFlagError");
    });
  });
});
