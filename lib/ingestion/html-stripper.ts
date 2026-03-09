import * as cheerio from 'cheerio';

/**
 * Strips HTML to meaningful text for LLM extraction.
 * Removes scripts, styles, nav, footer, headers.
 * Targets <main> content first, falls back to <body>.
 * Truncates to maxChars to stay within token limits.
 */
export function stripHtmlToText(html: string, maxChars = 32_000): string {
  const $ = cheerio.load(html);

  // Remove noise elements
  $('script, style, noscript, iframe, svg, img').remove();
  $('nav, header, footer, [role="navigation"], [role="banner"]').remove();
  $('[class*="cookie"], [class*="popup"], [class*="modal"], [id*="cookie"]').remove();

  // Prefer main content area
  const main = $('main, [role="main"], article, #content, .content, #main').first();
  const root = main.length ? main : $('body');

  // Extract text preserving some structure
  let text = '';
  root.find('h1, h2, h3, h4, p, li, td, th, span, div, a').each((_, el) => {
    const t = $(el).clone().children().remove().end().text().trim();
    if (t.length > 1) text += t + '\n';
  });

  // Collapse whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return text.slice(0, maxChars);
}
