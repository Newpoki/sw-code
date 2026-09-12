import { describe, expect, it } from "vitest"
import type { z } from "zod"

import {
  COUPON_CODE_MAX_LENGTH,
  HIVE_ID_MAX_LENGTH,
  MEMBER_LABEL_MAX_LENGTH,
  addMemberInputSchema,
  couponCodeSchema,
  firstErrorMessage,
  hiveIdSchema,
  lengthRangeMessage,
  memberLabelSchema,
  removeMemberInputSchema,
  runRedemptionInputSchema,
  setMemberEnabledInputSchema,
} from "@/domain/schemas"

/**
 * Unit tests for the shared validation schemas.
 *
 * They pin the two behaviours the rest of the app relies on: validation happens
 * after trimming and yields the trimmed value with its letter case preserved
 * (Requirements 1.1, 2.3), and every length rejection carries a message naming
 * the field and its allowed character-count range (Requirements 1.3, 2.10, 3.7).
 */

/** Message of the first issue of a failed parse. */
function messageOf(schema: z.ZodType, input: unknown): string {
  const result = schema.safeParse(input)
  expect(
    result.success,
    `expected ${JSON.stringify(input)} to be rejected`
  ).toBe(false)
  return result.success ? "" : firstErrorMessage(result.error)
}

describe("lengthRangeMessage", () => {
  it("names the field and its allowed character-count range", () => {
    expect(lengthRangeMessage("Member_Label", 1, 40)).toBe(
      "Member_Label must hold 1 to 40 characters"
    )
  })
})

describe("memberLabelSchema", () => {
  it("trims first and returns the trimmed value with its letter case preserved", () => {
    expect(memberLabelSchema.parse("  Alice McCase \t\n")).toBe("Alice McCase")
  })

  it("accepts the boundary lengths 1 and 40 after trimming", () => {
    expect(memberLabelSchema.parse(" a ")).toBe("a")
    const atMax = "x".repeat(MEMBER_LABEL_MAX_LENGTH)
    expect(memberLabelSchema.parse(`   ${atMax}   `)).toBe(atMax)
  })

  it("rejects whitespace-only and over-long values with a message naming the field and range", () => {
    const expected = "Member_Label must hold 1 to 40 characters"
    expect(messageOf(memberLabelSchema, "")).toBe(expected)
    expect(messageOf(memberLabelSchema, "   \t\n ")).toBe(expected)
    expect(
      messageOf(memberLabelSchema, "x".repeat(MEMBER_LABEL_MAX_LENGTH + 1))
    ).toBe(expected)
    expect(messageOf(memberLabelSchema, 42)).toBe(expected)
  })
})

describe("hiveIdSchema", () => {
  it("accepts 1 to 64 characters after trimming and rejects 65", () => {
    const atMax = "9".repeat(HIVE_ID_MAX_LENGTH)
    expect(hiveIdSchema.parse(` ${atMax} `)).toBe(atMax)
    expect(messageOf(hiveIdSchema, "9".repeat(HIVE_ID_MAX_LENGTH + 1))).toBe(
      "Hive_ID must hold 1 to 64 characters"
    )
  })
})

describe("couponCodeSchema", () => {
  it("trims and preserves the letter case of the remaining characters", () => {
    expect(couponCodeSchema.parse("\t SW2025NewYear \n")).toBe("SW2025NewYear")
  })

  it("rejects a value holding zero characters before trimming", () => {
    expect(messageOf(couponCodeSchema, "")).toBe(
      "Coupon_Code must hold 1 to 64 characters"
    )
  })

  it("rejects a value holding zero characters after trimming", () => {
    expect(messageOf(couponCodeSchema, "  \n  ")).toBe(
      "Coupon_Code must hold 1 to 64 characters"
    )
  })

  it("rejects a value longer than 64 characters", () => {
    expect(
      messageOf(couponCodeSchema, "A".repeat(COUPON_CODE_MAX_LENGTH + 1))
    ).toBe("Coupon_Code must hold 1 to 64 characters")
  })
})

describe("payload schemas", () => {
  it("addMemberInputSchema returns both values trimmed", () => {
    expect(
      addMemberInputSchema.parse({
        memberLabel: " Alice ",
        hiveId: " 1234567890 ",
      })
    ).toEqual({
      memberLabel: "Alice",
      hiveId: "1234567890",
    })
  })

  it("addMemberInputSchema names the rejected field", () => {
    expect(
      messageOf(addMemberInputSchema, {
        memberLabel: "  ",
        hiveId: "1234567890",
      })
    ).toBe("Member_Label must hold 1 to 40 characters")
    expect(
      messageOf(addMemberInputSchema, { memberLabel: "Alice", hiveId: " " })
    ).toBe("Hive_ID must hold 1 to 64 characters")
  })

  it("setMemberEnabledInputSchema requires an id and a boolean flag", () => {
    expect(
      setMemberEnabledInputSchema.parse({ id: " 01J8Z0X5QK ", enabled: false })
    ).toEqual({
      id: "01J8Z0X5QK",
      enabled: false,
    })
    expect(
      messageOf(setMemberEnabledInputSchema, {
        id: "01J8Z0X5QK",
        enabled: "yes",
      })
    ).toBe("enabled must hold true or false")
    expect(
      messageOf(setMemberEnabledInputSchema, { id: "  ", enabled: true })
    ).toBe("Member id must hold 1 to 64 characters")
  })

  it("removeMemberInputSchema and runRedemptionInputSchema carry one value each", () => {
    expect(removeMemberInputSchema.parse({ id: "01J8Z0X5QK" })).toEqual({
      id: "01J8Z0X5QK",
    })
    expect(runRedemptionInputSchema.parse({ couponCode: " SW2025 " })).toEqual({
      couponCode: "SW2025",
    })
    expect(
      Object.keys(runRedemptionInputSchema.parse({ couponCode: "SW2025" }))
    ).toEqual(["couponCode"])
  })
})
