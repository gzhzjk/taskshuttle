/**
 * What counts as a link in a markdown file.
 *
 * One owner for a fact two checks need: `check-doc-links.mjs` resolves every
 * link in every document git carries, and the maintainers' export resolves the ones
 * inside the set it publishes. One was a bare regex over the whole file,
 * which reads code as prose — a bracket class before a group, `["'](?:a|b)`,
 * is a Markdown link to anything that does not know it is looking at a code
 * sample, and a migration record in this project contains exactly that line.
 */

// Not a markdown parser. It has to be right about exactly two things — where a
// code region starts and ends, and where a link target sits — and being wrong
// about anything else costs nothing here.
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LINK = /\[[^\]]*\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;

/**
 * Every local link target in a markdown document, with the line it sits on.
 *
 * External schemes and bare fragments are dropped: neither names a file, so
 * neither is something a tree can be asked about. Fenced blocks and inline
 * code spans are skipped — a link inside them is a sample, not a reference,
 * and resolving it against the tree is a false finding.
 *
 * Inline links only. A reference-style link (`[a][b]`) or an autolink is not
 * returned, so it is not checked — an under-approximation, and the honest
 * shape for a check whose false positives cost more than its misses: this
 * repository writes inline links and a wrong refusal blocks an export.
 *
 * @param {string} text - the document's full contents
 * @returns {{ target: string, line: number }[]} targets in document order, each
 *   with its 1-based line number; a target keeps any `#fragment` stripped
 */
export function localLinks(text) {
  const found = [];
  let fence;
  text.split('\n').forEach((line, index) => {
    const opening = FENCE.exec(line);
    if (fence !== undefined) {
      // A fence closes only on the marker that opened it, and only on one at
      // least as long — otherwise a ```` block quoting ``` closes on its own
      // sample and every line after it is read as prose.
      if (opening !== null && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = undefined;
      return;
    }
    if (opening !== null) { fence = opening[1]; return; }
    // Inline code, after fences so a fence line is never treated as prose.
    const prose = line.replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(LINK)) {
      const target = match[1].replace(/#.*$/, '');
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      found.push({ target, line: index + 1 });
    }
  });
  return found;
}
