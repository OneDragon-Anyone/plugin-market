/** README 与 changelog 的 HTML 净化：只放行展示需要的标签，相对地址按插件仓库与提交补全。 */

import sanitizeHtml from "sanitize-html";

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:|^\/\//i;

function resolveRepoUrl(url: string, base: string): string {
  if (!url || url.startsWith("#") || ABSOLUTE_URL.test(url)) return url;
  return new URL(url.replace(/^\/+/, ""), base).toString();
}

/** GitHub 渲染好的 HTML 直接进站点前过一遍：脚本、内联样式、站外跳转的裸链接都挡掉 */
export function renderSafeHtml(html: string | undefined, repo: string, commit: string): string {
  if (!html) return "";
  const blobBase = `https://github.com/${repo}/blob/${commit}/`;
  const rawBase = `https://raw.githubusercontent.com/${repo}/${commit}/`;
  const aligned = ["align"];

  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "details", "summary", "kbd", "del", "ins", "sup", "sub"],
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "title", "width", "height", "align"],
      td: ["align", "colspan", "rowspan"],
      th: ["align", "colspan", "rowspan"],
      div: aligned,
      p: aligned,
      h1: aligned,
      h2: aligned,
      h3: aligned,
      details: ["open"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    transformTags: {
      a: (tagName, attribs) => {
        const href = resolveRepoUrl(attribs.href ?? "", blobBase);
        const external = href && !href.startsWith("#");
        return {
          tagName,
          attribs: external ? { ...attribs, href, rel: "nofollow noopener noreferrer", target: "_blank" } : { ...attribs, href }
        };
      },
      img: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, src: resolveRepoUrl(attribs.src ?? "", rawBase), loading: "lazy" }
      })
    }
  });
}
