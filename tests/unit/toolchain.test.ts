import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { cn } from "@/lib/utils"

describe("test toolchain (node environment)", () => {
  it("resolves the @/* alias against src/", () => {
    expect(cn("a", "b")).toBe("a b")
  })

  it("runs in the node environment", () => {
    expect(typeof document).toBe("undefined")
  })

  it("has fast-check available", () => {
    fc.assert(
      fc.property(fc.string(), (value) => value.length >= 0),
      { numRuns: 100 }
    )
  })
})
