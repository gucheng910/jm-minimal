// 评论富文本：按原 app 行为渲染 HTML，但做白名单清洗（防 XSS）；
// 把 class="emoji emojiXXXXX" 的空 span 还原为原生 emoji 字符。

const ALLOWED_TAGS = new Set([
  "P", "DIV", "SPAN", "BR", "B", "STRONG", "I", "EM", "U", "S", "A", "IMG",
  "UL", "OL", "LI", "BLOCKQUOTE", "CODE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6"
]);

const ALLOWED_ATTRS = new Set([
  "href", "src", "alt", "title", "target", "rel", "class", "style",
  "width", "height", "align", "color", "dir", "start", "type"
]);

export function sanitizeCommentHtml(raw: string): string {
  if (!raw) return "";
  const doc = new DOMParser().parseFromString("<body>" + raw + "</body>", "text/html");
  const root = doc.body;

  // 1) emoji span -> unicode 字符
  root.querySelectorAll("span[class]").forEach((sp) => {
    const cls = String((sp as HTMLElement).className || "");
    const m = cls.match(/emoji([0-9a-fA-F]{3,8})/);
    if (!m) return;
    const cp = parseInt(m[1], 16);
    if (cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
      try {
        sp.replaceWith(document.createTextNode(String.fromCodePoint(cp)));
      } catch { /* keep */ }
    }
  });

  // 2) 高危节点直接删除
  root.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button,textarea,svg").forEach((n) => n.remove());

  // 3) 白名单遍历：非法标签去壳保留文本，非法/危险属性删除
  const walk = (parent: HTMLElement) => {
    for (const node of Array.from(parent.children)) {
      const el = node as HTMLElement;
      if (!ALLOWED_TAGS.has(el.tagName)) {
        walk(el);
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
        } else if (!ALLOWED_ATTRS.has(name)) {
          el.removeAttribute(attr.name);
        } else if ((name === "href" || name === "src") && !/^(https?:|mailto:|\/)/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        } else if (name === "style" && /url\s*\(|expression|@import|javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
      walk(el);
    }
  };
  walk(root);
  return root.innerHTML;
}
