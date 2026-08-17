import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import type { Request } from "express";
import { DbError, UnknownFlagError } from "../../shared/errors.js";
import { failureTag } from "./test-helpers.js";

vi.mock("../db.js", () => ({
  deleteFlag: vi.fn(),
}));

import * as db from "../db.js";
import { deleteFlag } from "./deleteFlag.js";

const req = (params: unknown): Request => ({ params }) as unknown as Request;

describe("deleteFlag", () => {
  it("deletes the flag", async () => {
    vi.mocked(db.deleteFlag).mockReturnValue(Effect.void);

    const exit = await Effect.runPromiseExit(deleteFlag(req({ id: "1" })));

    expect(Exit.isSuccess(exit) && exit.value).toBe(null);
    expect(db.deleteFlag).toHaveBeenCalledWith(1);
  });

  it("fails with BadRequestError when `id` is not an integer", async () => {
    const exit = await Effect.runPromiseExit(deleteFlag(req({ id: "not-a-number" })));

    expect(failureTag(exit)).toBe("BadRequestError");
  });

  it("fails with UnknownFlagError when the flag does not exist", async () => {
    vi.mocked(db.deleteFlag).mockReturnValue(
      Effect.fail(new UnknownFlagError({ message: "not found" })),
    );

    const exit = await Effect.runPromiseExit(deleteFlag(req({ id: "1" })));

    expect(failureTag(exit)).toBe("UnknownFlagError");
  });

  it("fails with DbError when the db layer fails", async () => {
    vi.mocked(db.deleteFlag).mockReturnValue(Effect.fail(new DbError({ message: "boom" })));

    const exit = await Effect.runPromiseExit(deleteFlag(req({ id: "1" })));

    expect(failureTag(exit)).toBe("DbError");
  });
});
