/**
 * Unit tests for the display preparation of an upstream response message
 * (Requirement 6.2).
 *
 * `stripUpstreamMarkup` removes HTML tags from a `retMsg` before the Web_Client
 * shows it. The cases below are grouped by the three things that can go wrong:
 * a tag survives, a tag is *interpreted* rather than deleted, or ordinary prose
 * is eaten by an over-eager pattern.
 */

import { describe, expect, it } from "vitest"

import { stripUpstreamMarkup } from "@/domain/upstreamMessage"
import { FIXTURE_BODIES } from "../property/generators"

describe("stripUpstreamMarkup removes upstream tags", () => {
  it("turns the documented (H306) line break into a real newline", () => {
    // The reason this module exists.
    expect(
      stripUpstreamMarkup("Invalid coupon code.<br/>Please check again.")
    ).toBe("Invalid coupon code.\nPlease check again.")
  })

  it("accepts every spelling of a line break tag", () => {
    for (const tag of ["<br>", "<br/>", "<br />", "<BR>", "<Br />"]) {
      expect(stripUpstreamMarkup(`a${tag}b`)).toBe("a\nb")
    }
  })

  it("removes a tag rather than interpreting it, keeping the text between", () => {
    /* The tag is deleted; its text content survives as inert characters. Nothing
     * in the output can become an element, because the output is a plain string
     * rendered as a React text child. */
    expect(stripUpstreamMarkup('<script>alert("xss")</script>')).toBe(
      'alert("xss")'
    )
    expect(stripUpstreamMarkup("<b>bold</b><i>italic</i>")).toBe("bolditalic")
  })

  it("removes a self-closing tag that carries an event handler", () => {
    expect(
      stripUpstreamMarkup("<img src=x onerror=alert(1)> Contact support.")
    ).toBe("Contact support.")
  })

  it("removes a table-structure escape attempt", () => {
    expect(stripUpstreamMarkup("</td></tr><tr><td>injected")).toBe("injected")
  })

  it("collapses the blank lines that removing block tags leaves behind", () => {
    expect(stripUpstreamMarkup("<div>a</div><br/><br/><br/><div>b</div>")).toBe(
      "a\n\nb"
    )
  })

  it("leaves a message holding no markup alone, apart from surrounding space", () => {
    expect(stripUpstreamMarkup("  The coupon gift has been sent.  ")).toBe(
      "The coupon gift has been sent."
    )
  })

  it("returns the empty string for a message that was only markup", () => {
    // The caller substitutes its own placeholder for this.
    expect(stripUpstreamMarkup("<br/>")).toBe("")
    expect(stripUpstreamMarkup("")).toBe("")
  })
})

describe("stripUpstreamMarkup does not eat ordinary prose", () => {
  it("keeps comparison operators, which a naive tag pattern would delete", () => {
    /*
     * `/<[^>]*>/` matches `< 2 && 3 >` here and would leave `1  2`. Requiring a
     * letter directly after `<` is what prevents that.
     */
    expect(stripUpstreamMarkup("1 < 2 && 3 > 2")).toBe("1 < 2 && 3 > 2")
    expect(stripUpstreamMarkup("a < b")).toBe("a < b")
  })

  it("keeps stray angle brackets", () => {
    expect(stripUpstreamMarkup("<<>>&")).toBe("<<>>&")
  })

  it("does not decode HTML entities", () => {
    /*
     * Deliberate: decoding `&lt;br/&gt;` would manufacture the very tag this
     * module removes. Entities stay as stored, and cannot become markup.
     */
    expect(stripUpstreamMarkup("&lt;br/&gt;")).toBe("&lt;br/&gt;")
    expect(stripUpstreamMarkup("&amp;&quot;")).toBe("&amp;&quot;")
  })

  it("is total over hostile input and never throws", () => {
    for (const message of ["<", ">", "</", "<a", "<>", "< >", "\u0000", "🎁"]) {
      expect(typeof stripUpstreamMarkup(message)).toBe("string")
    }
  })
})

describe("stripUpstreamMarkup against the documented fixture bodies", () => {
  it("leaves the two prose messages unchanged and de-tags the third", () => {
    /*
     * Read from `fixtures/upstream/`, so this states what a reader actually sees
     * for each documented response rather than restating a literal.
     */
    const messageOf = (fixture: keyof typeof FIXTURE_BODIES): string =>
      (JSON.parse(FIXTURE_BODIES[fixture]) as { retMsg: string }).retMsg

    expect(stripUpstreamMarkup(messageOf("success-100.json"))).toBe(
      "The coupon gift has been sent."
    )
    expect(stripUpstreamMarkup(messageOf("already-used-h304.json"))).toBe(
      "This coupon code has already been used."
    )
    expect(stripUpstreamMarkup(messageOf("invalid-coupon-h306.json"))).toBe(
      "Invalid coupon code.\nPlease check again."
    )
  })
})
