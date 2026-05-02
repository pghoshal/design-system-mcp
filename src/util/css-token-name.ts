/**
 * Convert Style Dictionary token paths into valid CSS custom property names.
 *
 * Token Studio token-set names can contain characters like "/" (for example
 * "light/color"). Those names are valid design-system paths, but not valid
 * CSS custom property identifiers, so all CSS-facing tools must use this
 * single sanitizer.
 */
export function cssTokenName(path: readonly string[]): string {
  return path.map(encodeCssTokenSegment).join("-");
}

export function cssTokenVar(path: readonly string[]): string {
  return `--${cssTokenName(path)}`;
}

function encodeCssTokenSegment(segment: string): string {
  if (segment.length === 0) return "_u0000_";
  let out = "";
  for (const char of segment) {
    out += /^[a-zA-Z0-9]$/.test(char) ? char : cssEscape(char);
  }
  return out;
}

function cssEscape(char: string): string {
  return `_u${char.codePointAt(0)?.toString(16).padStart(4, "0")}_`;
}
