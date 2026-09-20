// Reading the JSON-with-comments that tool configs are written in — tsconfig,
// jsconfig, opencode.jsonc all allow // and /* */ comments and trailing commas
// that JSON.parse rejects. This strips them string-aware, so a `//`, `/*` or `,`
// inside a string literal is left untouched, then parses. Returns null when the
// text isn't valid enough to reason about.

export function parseJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        out += text[i];
        if (text[i] === "\\") {
          out += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === ",") {
      // A trailing comma is one followed only by whitespace (and any comments)
      // before a } or ]. Skip those to see what actually comes next.
      let j = i + 1;
      while (j < n) {
        const d = text[j];
        if (d === " " || d === "\t" || d === "\r" || d === "\n") { j++; continue; }
        if (d === "/" && text[j + 1] === "/") { j += 2; while (j < n && text[j] !== "\n") j++; continue; }
        if (d === "/" && text[j + 1] === "*") { j += 2; while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++; j = Math.min(j + 2, n); continue; }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++; // drop the trailing comma
        continue;
      }
    }
    out += c;
    i++;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
