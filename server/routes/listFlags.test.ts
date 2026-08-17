import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import type { FeatureFlag } from "../../shared/types.js";

vi.mock("../db.js", () => ({
  listFlags: vi.fn(),
}));

import * as db from "../db.js";
import { listFlags } from "./listFlags.js";

const flag: FeatureFlag = {
  id: 1,
  name: "my-flag",
  enabled: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("listFlags", () => {
  it("returns every flag from the db", async () => {
    vi.mocked(db.listFlags).mockReturnValue(Effect.succeed([flag]));

    const exit = await Effect.runPromiseExit(listFlags());

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(exit._tag === "Success" && exit.value).toEqual([flag]);
  });
});
