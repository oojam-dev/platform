import { describe, expect, it } from "vitest";

import { duration } from "./format";
import { isLive } from "./live";

describe("isLive", () => {
  it("polls while a build is in flight and stops once it finishes", () => {
    for (const s of ["screening", "building", "gating", "pr_open", "merging", "deploying"]) expect(isLive(s)).toBe(true);
    for (const s of ["queued", "deployed", "failed", "rolled_back", "skipped"]) expect(isLive(s)).toBe(false);
  });
});

describe("duration", () => {
  it("formats elapsed time compactly", () => {
    expect(duration(-3)).toBe("0s");
    expect(duration(45.9)).toBe("45s");
    expect(duration(452)).toBe("7m 32s");
    expect(duration(3840)).toBe("1h 04m");
  });
});
