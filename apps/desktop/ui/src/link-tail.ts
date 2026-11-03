/**
 * Where an autolink ends and the sentence around it resumes.
 *
 * A URL in prose has no delimiter — the reader relies on the link stopping
 * where the address does. `marked` gets that right for ASCII: a trailing `.` or
 * `,` is stripped. It gets it wrong for Chinese, because the autolink pattern
 * treats everything that is not whitespace or `<` as part of the address, and a
 * CJK full stop is neither.
 *
 * Measured on the real parser:
 *
 *   见 http://localhost:3000/。
 *   → <a href="http://localhost:3000/%E3%80%82">http://localhost:3000/。</a>
 *
 * and the same shape swallows a parenthetical written straight after an address
 * — `…/（vite 8 换端口后重启过）` becomes one link to an address that cannot
 * exist.
 *
 * The rule is punctuation, not script. A CJK ideograph may legitimately be part
 * of a path, and the parser handles it correctly when there is a space after:
 *
 *   见 https://example.com/路径/中文 。   → link is exactly …/路径/中文
 *
 * So the cut is made at the first *punctuation* character, wherever it is, and
 * never at a letter. That location is what distinguishes this from stripping
 * the tail: with no space after it, `…/a，然后` puts the comma in the middle of
 * the link's text, and only a left-to-right scan finds it.
 */

/** Punctuation that ends a clause rather than continuing an address. */
const TRAILING = new Set([
  "。", "、", "，", "；", "：", "？", "！",
  "…", "‥",
  "—", "―", "～", "〜",
  "”", "’", "』", "」", "》", "】", "〕", "〗",
]);

/**
 * Openers, and the closer each one pairs with.
 *
 * A bracketed aside starts at its opener, so the cut lands there and the whole
 * aside comes off. Cutting at the closer instead would leave
 * `…/（vite 8 换端口后重启过` as the address — still wrong, and worse than the
 * original because it no longer looks wrong.
 */
const OPENERS: Record<string, string> = {
  "（": "）",
  "【": "】",
  "《": "》",
  "「": "」",
  "『": "』",
  "〔": "〕",
  "〖": "〗",
  "［": "］",
  "｛": "｝",
};

/** A closer with no opener before it still ends the address. */
const CLOSERS = new Set(Object.values(OPENERS));

/**
 * Split the sentence back off the end of a link's text.
 *
 * `keep` is the address, `tail` is what the reader sees after it and what the
 * link must not cover. `tail` is empty for an address that ends where the text
 * does, which is the common case and the one that must not change.
 */
export function splitLinkTail(text: string): { keep: string; tail: string } {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    // Punctuation ends an address. A letter does not: `example.com/路径` is a
    // real URL, and cutting there would break it.
    if (TRAILING.has(ch) || OPENERS[ch] !== undefined || CLOSERS.has(ch)) {
      // A text that is nothing but punctuation was not an address to begin
      // with; handing back "" would delete it from the page.
      if (i === 0) return { keep: text, tail: "" };
      return { keep: text.slice(0, i), tail: text.slice(i) };
    }
  }
  return { keep: text, tail: "" };
}
