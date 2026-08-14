/**
 * mdsvex/Svelte text escaping — ONE copy, shared by every docs generator.
 *
 * Extracted from scripts/docs-pages.ts when scripts/docs-compose.ts needed the same rule and a
 * second implementation would have been written. It was not optional: the very first composed
 * page failed to compile because an entity definition contained a literal `{@html}`, which Svelte
 * parsed as an expression. The comment below records three separate traps found the hard way, and
 * a reimplementation would have had to rediscover all of them.
 */

/**
 * Escape characters that mdsvex/Svelte would otherwise try to parse as markup —
 * `<word` reads as the start of an element/component tag (`<5%`, `<http://…>`
 * angle-bracket IRI notation) and `{...}` reads as a Svelte expression (`{@html}`,
 * `{ ?x ?y }` from SPARQL examples, `{name}` path placeholders). The docs TTLs are
 * prose written for humans, not markdown, so free text is escaped uniformly wherever
 * it's embedded in the generated body.
 *
 * `<`/`>` use plain HTML entities — CommonMark's HTML serializer re-escapes those back
 * to `&lt;`/`&gt;` in the compiled output (they're HTML metacharacters), so they reach
 * Svelte's compiler as harmless literal text.
 *
 * `{`/`}` are NOT HTML metacharacters, so nothing re-escapes them: `&#123;`/`&#125;`
 * numeric character references get *decoded* to literal `{`/`}` per the CommonMark
 * spec and still hit Svelte's mustache parser. A Svelte string-literal mustache
 * (`{'{'}`) dodges that — except mdsvex's default `smartypants` transform mangles the
 * straight quotes inside it into curly quotes, breaking the JS. `String.fromCharCode`
 * needs no quotes at all, so it survives every stage untouched.
 */
export const MD_ESCAPES: Record<string, string> = {
  '<': '&lt;', '>': '&gt;',
  '{': '{String.fromCharCode(123)}', '}': '{String.fromCharCode(125)}',
};
export function escapeMdText(s: string): string {
  // Single pass over a callback, not chained .replace() calls — the `{`/`}`
  // replacement text itself contains `{`/`}` characters, and a second chained
  // .replace() would re-match (and mangle) what the first one just inserted.
  return s.replace(/[<>{}]/g, (c) => MD_ESCAPES[c]);
}
