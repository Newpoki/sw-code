// Feature: mongodb-google-auth-admin, Property 13: The Account_Role is the
// Admin_Allowlist membership of the folded email.
//
// For any Admin_Allowlist, including the empty one, for any email address in
// any letter case with any surrounding whitespace, and for any Account_Role a
// stored User_Account already held, the Account_Role written for that email
// equals the Admin_Role exactly when that email, with leading and trailing
// whitespace characters removed and converted to lower case, is
// character-for-character identical to an element of that allowlist, and equals
// the Member_Role otherwise, independently of the role that User_Account held
// before.
//
// Validates: Requirements 6.3, 6.10, 6.14.
//
// The rule is restated here from the requirements rather than borrowed from
// `deriveAccountRole`: `expectedRole` below folds the address with `trim()` and
// `toLowerCase()`, asks `Array.prototype.includes` for an exact element match,
// and answers `"admin"` or `"member"`. That is the whole of Requirement 6.3 and
// its negation in 6.14, and Requirement 6.10 is the case where the allowlist
// holds zero elements, so it is asserted as its own clause too.
//
// "Independently of the role that User_Account held before" needs a stored
// account to be meaningful, and no store exists at this layer yet: task 17
// builds the `user_accounts` mirror. `storeUserAccount` below is the smallest
// honest stand-in — a record holding a role, re-derived on every sign-in — so
// the clause is stated as: for every prior role the record could hold, the role
// written is the same one, and it is the one membership alone decides.
//
// Every Admin_Allowlist in this file comes out of `parseAdminAllowlist`, never
// out of a hand-built array. An allowlist is by construction the parse of an
// `ADMIN_EMAILS` value, so an element that is upper-case or padded is not a
// reachable state, and a test asserting a fold against one would be measuring
// something the system cannot hold.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH,
  deriveAccountRole,
  foldEmail,
  parseAdminAllowlist,
} from "@/domain/accounts"
import type { AccountRole } from "@/domain/accounts"

/* -------------------------------------------------------------------------- */
/* The rule, stated independently of the implementation                       */
/* -------------------------------------------------------------------------- */

/** The two roles a stored User_Account can already hold. */
const ACCOUNT_ROLES: readonly AccountRole[] = ["admin", "member"]

/**
 * Requirements 6.3 and 6.14: the folded address is an element of the allowlist,
 * or it is not.
 */
function expectedRole(
  email: string,
  allowlist: readonly string[]
): AccountRole {
  const folded = email.trim().toLowerCase()
  return allowlist.includes(folded) ? "admin" : "member"
}

/* -------------------------------------------------------------------------- */
/* A stand-in for the User_Account mirror                                     */
/* -------------------------------------------------------------------------- */

interface StoredUserAccount {
  readonly clerkUserId: string
  readonly email: string
  readonly role: AccountRole
}

/**
 * What the mirror does at sign-in: keep the account key, keep the asserted
 * address, and set the role from the allowlist. The role the record already
 * held is deliberately not read.
 */
function storeUserAccount(
  existing: StoredUserAccount,
  email: string,
  allowlist: readonly string[]
): StoredUserAccount {
  return {
    clerkUserId: existing.clerkUserId,
    email,
    role: deriveAccountRole(email, allowlist),
  }
}

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/*                                                                            */
/* Defined here rather than in `tests/property/generators.ts`: they are about  */
/* email addresses and `ADMIN_EMAILS` values, which no other property needs.   */
/* -------------------------------------------------------------------------- */

/** Whitespace `trim` removes, including the ones a paste can carry in. */
const WHITESPACE_UNITS = [" ", "\t", "\n", "\r", "\f", "\v", "\u00a0", "\u2028"]

/** Padding, possibly empty, that `trim` removes entirely. */
const paddingArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_UNITS), { minLength: 0, maxLength: 4 })
  .map((units) => units.join(""))

/** Padding of at least one character, so it always changes the value. */
const nonEmptyPaddingArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_UNITS), { minLength: 1, maxLength: 4 })
  .map((units) => units.join(""))

const LOCAL_UNITS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-+"
)
const DOMAIN_UNITS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
)

function partArb(units: readonly string[], maxLength: number) {
  return fc
    .array(fc.constantFrom(...units), { minLength: 1, maxLength })
    .map((characters) => characters.join(""))
}

/**
 * An address of ASCII letters, digits, and the punctuation an address carries,
 * in mixed case.
 *
 * ASCII on purpose wherever a test varies the letter case of an address it also
 * folds: outside ASCII, `toLowerCase` is not the inverse of `toUpperCase` —
 * `"ß".toUpperCase()` is `"SS"` and `"İ".toLowerCase()` grows a combining dot —
 * so a Unicode round trip would fail the arrangement rather than the rule. The
 * classification clause below, which folds but never re-cases, uses arbitrary
 * text instead.
 */
const asciiEmailArb: fc.Arbitrary<string> = fc
  .tuple(
    partArb(LOCAL_UNITS, 12),
    partArb(DOMAIN_UNITS, 10),
    partArb(DOMAIN_UNITS, 3)
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)

/** Text reaching astral-plane and combining characters, and the empty string. */
const arbitraryTextArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "grapheme", maxLength: 20 }) },
  { weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 20 }) },
  { weight: 1, arbitrary: fc.constant("") }
)

/**
 * An address the Identity_Provider might assert: a well-formed one, one in an
 * arbitrary case with arbitrary padding, arbitrary text holding a commercial at
 * character, and arbitrary text holding none.
 */
const assertedEmailArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: asciiEmailArb },
  {
    weight: 4,
    arbitrary: fc
      .tuple(paddingArb, asciiEmailArb, paddingArb)
      .map(([left, email, right]) => `${left}${email}${right}`),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(arbitraryTextArb, arbitraryTextArb)
      .map(([local, domain]) => `${local}@${domain}`),
  },
  { weight: 2, arbitrary: arbitraryTextArb },
  {
    weight: 1,
    arbitrary: fc.constant(
      "a".repeat(ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH + 10) + "@b.c"
    ),
  }
)

/**
 * An `ADMIN_EMAILS` value: addresses joined by commas, variously padded and
 * cased, mixed with elements the parser discards, and sometimes absent or
 * blank so the zero-element allowlist of Requirements 6.2 and 6.10 is reached.
 */
const adminEmailsValueArb: fc.Arbitrary<string | undefined> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .array(
        fc.oneof(
          { weight: 5, arbitrary: asciiEmailArb },
          { weight: 1, arbitrary: partArb(LOCAL_UNITS, 8) },
          { weight: 1, arbitrary: paddingArb }
        ),
        { minLength: 0, maxLength: 8 }
      )
      .chain((elements) =>
        fc
          .tuple(
            fc.array(paddingArb, {
              minLength: elements.length,
              maxLength: elements.length,
            }),
            fc.array(paddingArb, {
              minLength: elements.length,
              maxLength: elements.length,
            })
          )
          .map(([lefts, rights]) =>
            elements
              .map((element, at) => `${lefts[at]}${element}${rights[at]}`)
              .join(",")
          )
      ),
  },
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: paddingArb }
)

/** An allowlist, as the parse of some `ADMIN_EMAILS` value. */
const allowlistArb: fc.Arbitrary<readonly string[]> = adminEmailsValueArb.map(
  (raw) => parseAdminAllowlist(raw)
)

/** An allowlist holding at least one element, with one of its elements. */
const listedAddressArb: fc.Arbitrary<{
  allowlist: readonly string[]
  listed: string
}> = fc
  .array(asciiEmailArb, { minLength: 1, maxLength: 6 })
  .map((emails) => parseAdminAllowlist(emails.join(",")))
  .filter((allowlist) => allowlist.length > 0)
  .chain((allowlist) =>
    fc.record({
      allowlist: fc.constant(allowlist),
      listed: fc.constantFrom(...allowlist),
    })
  )

/** Each character of `value` with its letter case swapped. */
function swapCase(value: string): string {
  return Array.from(value, (character) => {
    const lower = character.toLowerCase()
    return character === lower ? character.toUpperCase() : lower
  }).join("")
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 13: the Account_Role is the Admin_Allowlist membership of the folded email", () => {
  it("derives exactly the role the folded-membership rule predicts, for any address and any allowlist", () => {
    fc.assert(
      fc.property(allowlistArb, assertedEmailArb, (allowlist, email) => {
        // Requirements 6.3 and 6.14 are the two halves of one classification,
        // so the assertion is an equality against the rule rather than a case
        // analysis: no address escapes it, including one holding no commercial
        // at character and one longer than 254 characters.
        expect(deriveAccountRole(email, allowlist)).toBe(
          expectedRole(email, allowlist)
        )
      }),
      { numRuns: 300 }
    )
  })

  it("writes the same role whatever role the stored User_Account already held", () => {
    fc.assert(
      fc.property(
        allowlistArb,
        assertedEmailArb,
        fc.string({ minLength: 1, maxLength: 12 }),
        (allowlist, email, clerkUserId) => {
          const written = ACCOUNT_ROLES.map((held) =>
            storeUserAccount(
              { clerkUserId, email: "held@example.test", role: held },
              email,
              allowlist
            )
          )

          // Requirements 6.3 and 6.14: "whether that Sign_In_Flow creates that
          // User_Account or that User_Account already held" the other role.
          // Both prior roles yield one role, and it is the derived one.
          const roles = new Set(written.map((account) => account.role))
          expect(roles.size).toBe(1)
          expect([...roles][0]).toBe(expectedRole(email, allowlist))

          // The account key survives the write; only the role and the address
          // are decided by the sign-in.
          for (const account of written) {
            expect(account.clerkUserId).toBe(clerkUserId)
            expect(account.email).toBe(email)
          }
        }
      ),
      { numRuns: 200 }
    )
  })

  it("gives a listed address the Admin_Role in any letter case with any padding", () => {
    fc.assert(
      fc.property(
        listedAddressArb,
        nonEmptyPaddingArb,
        paddingArb,
        fc.boolean(),
        ({ allowlist, listed }, left, right, upper) => {
          const recased = upper ? listed.toUpperCase() : swapCase(listed)
          const asserted = `${left}${recased}${right}`

          // The address reaching the derivation is not the stored element, and
          // differs from it only in case and whitespace, so an Admin_Role can
          // only come from folding it (Requirement 6.3).
          expect(asserted).not.toBe(listed)
          expect(foldEmail(asserted)).toBe(listed)

          expect(deriveAccountRole(asserted, allowlist)).toBe("admin")
        }
      ),
      { numRuns: 200 }
    )
  })

  it("gives an unlisted address the Member_Role even where it differs from a listed one by one character", () => {
    fc.assert(
      fc.property(
        listedAddressArb,
        fc.constantFrom("x", "1", ".", "-"),
        ({ allowlist, listed }, extra) => {
          // A near miss, not a random miss: the address is one character away
          // from an element, and still absent from the allowlist because
          // membership is character-for-character (Requirement 6.14).
          const nearMiss = `${listed}${extra}`
          fc.pre(!allowlist.includes(nearMiss))

          expect(deriveAccountRole(nearMiss, allowlist)).toBe("member")
        }
      ),
      { numRuns: 200 }
    )
  })

  it("gives every address the Member_Role while the allowlist holds zero elements", () => {
    fc.assert(
      fc.property(
        assertedEmailArb,
        fc.constantFrom<AccountRole>("admin", "member"),
        fc.string({ minLength: 1, maxLength: 12 }),
        (email, held, clerkUserId) => {
          // Requirement 6.10, reached through the parser rather than through a
          // hand-built empty array: every value yielding no surviving element
          // is the same zero-element allowlist.
          const empty = parseAdminAllowlist(undefined)
          expect(empty).toEqual([])

          expect(deriveAccountRole(email, empty)).toBe("member")
          expect(
            storeUserAccount(
              { clerkUserId, email: "held@example.test", role: held },
              email,
              empty
            ).role
          ).toBe("member")
        }
      ),
      { numRuns: 200 }
    )
  })

  it("moves a stored Admin_Role back to the Member_Role once the address leaves the allowlist", () => {
    fc.assert(
      fc.property(listedAddressArb, ({ allowlist, listed }) => {
        const account: StoredUserAccount = {
          clerkUserId: "clerk-user",
          email: listed,
          role: "member",
        }

        const promoted = storeUserAccount(account, listed, allowlist)
        expect(promoted.role).toBe("admin")

        // Requirement 6.14: the next sign-in against an allowlist the address
        // has left writes the Member_Role, and the Admin_Role it held is not
        // an input to that decision.
        const shortened = allowlist.filter((element) => element !== listed)
        const demoted = storeUserAccount(promoted, listed, shortened)
        expect(demoted.role).toBe("member")

        // ... and back again, so neither direction is a one-way latch.
        expect(storeUserAccount(demoted, listed, allowlist).role).toBe("admin")
      }),
      { numRuns: 200 }
    )
  })
})
