import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins truthy class names and drops falsy ones", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });

  it("resolves conflicting Tailwind utilities to the last one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
