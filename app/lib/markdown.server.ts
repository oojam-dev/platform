/**
 * Markdown for user and builder text. Raw HTML is disabled, so the output only ever
 * contains tags markdown-it itself generates, with escaped text. That's what makes it
 * acceptable to hand the result to dangerouslySetInnerHTML.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

// Only http(s) and mailto links survive (markdown-it already blocks javascript: and data:).
const defaultValidate = md.validateLink.bind(md);
md.validateLink = (url) => defaultValidate(url) && /^(https?:|mailto:|\/|#)/i.test(url.trim());

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  token.attrSet("rel", "nofollow ugc noopener");
  const href = String(token.attrGet("href") ?? "");
  if (/^https?:/i.test(href)) token.attrSet("target", "_blank");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Images from arbitrary hosts would leak viewers' IPs; render them as links instead.
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]!;
  const src = md.utils.escapeHtml(String(token.attrGet("src") ?? ""));
  const alt = md.utils.escapeHtml(token.content || "image");
  return `<a href="${src}" rel="nofollow ugc noopener" target="_blank">${alt}</a>`;
};

const cache = new Map<string, string>();

export function renderMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = md.render(text);
  if (cache.size > 500) cache.clear();
  cache.set(text, html);
  return html;
}
