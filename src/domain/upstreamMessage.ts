/**
 * Display preparation for an upstream response message (Requirement 6.2).
 *
 * The Upstream_API puts HTML in `retMsg`: the documented `(H306)` body is
 * `Invalid coupon code.<br/>Please check again.`, and an unrecognized Hive_ID
 * answers `Invalid Hive ID.<br/>Please check again.`. Those tags are noise to a
 * reader, so the Web_Client removes them before displaying the message.
 *
 * ## This does not weaken the injection defence — it strengthens it
 *
 * The original rule was "render every markup character as a visible character",
 * implemented by passing the message as a React text child. That is safe, but it
 * shows `<br/>` to the reader. This module removes the tag instead, and the
 * result is *still* passed as a React text child, so the two guarantees now hold
 * together:
 *
 *   1. no upstream text ever reaches the DOM as markup — unchanged, and still
 *      enforced by the `react/no-danger` ESLint rule and by
 *      `tests/unit/serverFunctionSurface.test.ts`;
 *   2. no upstream tag is displayed to the reader either.
 *
 * A tag is *deleted*, never interpreted. `<script>alert(1)</script>` becomes
 * `alert(1)`: visible, inert text. Nothing here can produce an element.
 *
 * ## What is deliberately left alone
 *
 * **HTML entities are not decoded.** Decoding `&lt;br/&gt;` would manufacture the
 * very `<br/>` this module exists to remove, so `&amp;` stays `&amp;`. It is
 * rare, it is honest about what was stored, and it cannot become markup.
 *
 * **The stored value is untouched.** This is display preparation only:
 * `RedemptionHistoryRecord.outcomes[].responseMessage` and
 * `UpstreamResult.responseMessage` keep the exact characters the Upstream_API
 * sent, so the Response_Parser's round-trip property (Requirement 4.8) and the
 * history records are unaffected.
 */

/**
 * A line break tag in any of its spellings: `<br>`, `<br/>`, `<br />`, `<BR>`.
 * Replaced by a real newline rather than dropped, because the tag carries
 * meaning — the upstream put it there to split a sentence — and the display
 * elements use `whitespace-pre-wrap`, so a newline renders as the break the
 * upstream intended.
 */
const LINE_BREAK_TAG = /<br\s*\/?>/gi

/**
 * Any other HTML tag, opening or closing.
 *
 * The leading `[a-z]` is load-bearing: it requires a letter immediately after
 * `<` (or after `</`), so a tag is recognized but ordinary prose containing
 * comparison operators is not. A message reading `1 < 2 && 3 > 2` holds the
 * substring `< 2 && 3 >`, which a naive `/<[^>]*>/` would happily delete along
 * with the arithmetic; this pattern leaves it intact.
 */
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi

/**
 * Collapses the runs of blank lines that removing block tags can leave behind,
 * e.g. `<div>a</div><div>b</div>` once its tags are gone.
 */
const EXCESS_BLANK_LINES = /\n{3,}/g

/**
 * The message as the Web_Client displays it: the same text with HTML tags
 * removed and `<br>` turned into a line break.
 *
 * Total: every string maps to a string and nothing throws, so a caller never has
 * to guard. A message holding no markup is returned with only its surrounding
 * whitespace trimmed.
 */
export function stripUpstreamMarkup(message: string): string {
  return message
    .replace(LINE_BREAK_TAG, "\n")
    .replace(HTML_TAG, "")
    .replace(EXCESS_BLANK_LINES, "\n\n")
    .trim()
}
