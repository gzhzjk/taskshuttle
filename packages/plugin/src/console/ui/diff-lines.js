/* Minimal line diff for ACP content[].type === "diff" entries (§10):
   LCS over lines; oversized inputs fall back to del-all/add-all.
   Shared by the UI (diff card rendering) and the server-side diff index
   (console-v2 §3.1) so the +adds/−dels counts can never diverge — same
   input, same numbers, by construction. */
export function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length * b.length > 160000) {
    return [...a.map((x) => ({ t: 'del', x })), ...b.map((x) => ({ t: 'add', x }))];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ t: 'ctx', x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ t: 'del', x: a[i] }); i++; }
    else { lines.push({ t: 'add', x: b[j] }); j++; }
  }
  while (i < a.length) lines.push({ t: 'del', x: a[i++] });
  while (j < b.length) lines.push({ t: 'add', x: b[j++] });
  return lines;
}
