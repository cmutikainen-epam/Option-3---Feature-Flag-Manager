import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import type { Request } from "express";
import { DbError, DuplicateFlagError } from "../../shared/errors.js";
import type { FeatureFlag } from "../../shared/types.js";
import { failureTag } from "./test-helpers.js";

vi.mock("../db.js", () => ({
  createFlag: vi.fn(),
}));

import * as db from "../db.js";
import { createFlag } from "./createFlag.js";

const flag: FeatureFlag = {
  id: 1,
  name: "my-flag",
  enabled: false,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
};

const reqWithBody = (body: unknown): Request => ({ body }) as unknown as Request;

describe("createFlag", () => {
  it("creates the flag", async () => {
    vi.mocked(db.createFlag).mockReturnValue(Effect.succeed(flag));

    const exit = await Effect.runPromiseExit(createFlag(reqWithBody({ name: "my-flag" })));

    expect(Exit.isSuccess(exit) && exit.value).toEqual(flag);
    expect(db.createFlag).toHaveBeenCalledWith("my-flag", false);
  });

  it("fails with BadRequestError when `name` is missing", async () => {
    const exit = await Effect.runPromiseExit(createFlag(reqWithBody({})));

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with BadRequestError when `name` is blank", async () => {
    const exit = await Effect.runPromiseExit(createFlag(reqWithBody({ name: "   " })));

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with BadRequestError when `enabled` is not a boolean", async () => {
    const exit = await Effect.runPromiseExit(
      createFlag(reqWithBody({ name: "my-flag", enabled: "yes" })),
    );

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with DuplicateFlagError when the db reports a duplicate", async () => {
    vi.mocked(db.createFlag).mockReturnValue(
      Effect.fail(new DuplicateFlagError({ message: "already exists" })),
    );

    const exit = await Effect.runPromiseExit(createFlag(reqWithBody({ name: "my-flag" })));

    expect(failureTag(exit)).toBe("DuplicateFlagError");
  });

  it("fails with DbError when the db layer fails", async () => {
    vi.mocked(db.createFlag).mockReturnValue(Effect.fail(new DbError({ message: "boom" })));

    const exit = await Effect.runPromiseExit(createFlag(reqWithBody({ name: "my-flag" })));

    expect(failureTag(exit)).toBe("DbError");
  });
});
