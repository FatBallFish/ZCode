/* Mikiko 官网共享轻量 Markdown 渲染：先整体 escape 再做结构替换，链接仅放行 http(s)。
 * share.html 与 changelog.html 共用（window.MikikoMarkdown 命名空间）。 */
"use strict";
(function (global) {
  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/gu,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }

  function inlineMarkdown(text) {
    return text
      .replace(/`([^`]+)`/gu, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/gu, "$1<em>$2</em>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );
  }

  function renderMarkdown(source) {
    const escaped = escapeHtml(source).replace(/\r\n/gu, "\n");
    const lines = escaped.split("\n");
    const html = [];
    let inCode = false,
      codeBuffer = [],
      listType = null,
      paragraph = [];
    const flushParagraph = () => {
      if (paragraph.length > 0) {
        html.push("<p>" + inlineMarkdown(paragraph.join("<br />")) + "</p>");
        paragraph = [];
      }
    };
    const flushList = () => {
      if (listType) {
        html.push(`</${listType}>`);
        listType = null;
      }
    };
    for (const line of lines) {
      if (/^```/u.test(line.trim())) {
        if (inCode) {
          html.push("<pre><code>" + codeBuffer.join("\n") + "</code></pre>");
          codeBuffer = [];
          inCode = false;
        } else {
          flushParagraph();
          flushList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeBuffer.push(line);
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/u.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/u.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
      const quote = /^>\s?(.*)$/u.exec(line);
      if (line.trim() === "") {
        flushParagraph();
        flushList();
        continue;
      }
      if (heading) {
        flushParagraph();
        flushList();
        html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
        continue;
      }
      if (bullet) {
        flushParagraph();
        if (listType !== "ul") {
          flushList();
          html.push("<ul>");
          listType = "ul";
        }
        html.push("<li>" + inlineMarkdown(bullet[1]) + "</li>");
        continue;
      }
      if (ordered) {
        flushParagraph();
        if (listType !== "ol") {
          flushList();
          html.push("<ol>");
          listType = "ol";
        }
        html.push("<li>" + inlineMarkdown(ordered[1]) + "</li>");
        continue;
      }
      if (quote) {
        flushParagraph();
        flushList();
        html.push("<blockquote>" + inlineMarkdown(quote[1]) + "</blockquote>");
        continue;
      }
      if (/^(-{3,}|\*{3,})$/u.test(line.trim())) {
        flushParagraph();
        flushList();
        html.push("<hr />");
        continue;
      }
      paragraph.push(line);
    }
    if (inCode) html.push("<pre><code>" + codeBuffer.join("\n") + "</code></pre>");
    flushParagraph();
    flushList();
    return html.join("");
  }

  global.MikikoMarkdown = { escapeHtml, renderMarkdown };
})(window);
