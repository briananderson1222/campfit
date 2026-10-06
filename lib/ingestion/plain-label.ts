/**
 * A list row's display label: its cited excerpt with the Markdown the page
 * preparation added taken out (`**First Session:** June 6th` reads
 * `First Session: June 6th`). The excerpt itself stays verbatim wherever a
 * citation check needs it.
 */
export function plainLabel(excerpt: string): string {
  return excerpt
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
