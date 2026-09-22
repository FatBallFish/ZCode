var e=`data-zcode-pptx-print-host`,t=`data-zcode-pptx-print-page`,n=`data-zcode-pptx-print-style`,r=1e4,i=new Set([`serif`,`sans-serif`,`monospace`,`cursive`,`fantasy`,`system-ui`,`ui-serif`,`ui-sans-serif`,`ui-monospace`,`emoji`,`math`,`fangsong`]),a={latin:`mmmmmmmmmwwwwwwwiiiiiiiii 0123456789 ABCDEFG`,cjk:`汉字排版测试かなカナ한글漢字`,symbol:`◆▶▥✦★☻♪—“”`},o=new Set([`pingfang sc`]),s=[`Hiragino Sans GB`,`Microsoft YaHei`,`Noto Sans CJK SC`,`Source Han Sans SC`,`Arial Unicode MS`,`sans-serif`],c=[`Songti SC`,`STSong`,`SimSun`,`Noto Serif CJK SC`,`Source Han Serif SC`,`serif`],l=[`Arial`,`Helvetica`,`system-ui`,`sans-serif`],u=[`Arial Narrow`,`Arial`,`Helvetica`,`sans-serif`],d=[`Times New Roman`,`Times`,`Georgia`,`serif`],f=[`Courier New`,`Menlo`,`Consolas`,`monospace`],p=[`Apple Symbols`,`Segoe UI Symbol`,`Noto Sans Symbols 2`,`Arial Unicode MS`,`sans-serif`];function m(e){return e.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/,`$1$2`).trim()}function h(e){let t=[],n=``,r=null,i=!1,a=()=>{let e=m(n);e&&t.push(e),n=``};for(let t of e){if(i){n+=t,i=!1;continue}if(t===`\\`){n+=t,i=!0;continue}if(r){n+=t,t===r&&(r=null);continue}if(t===`"`||t===`'`){r=t,n+=t;continue}if(t===`,`){a();continue}n+=t}return a(),t}function g(e){let t=m(e);return i.has(t.toLowerCase())?t.toLowerCase():/[\s,"']/.test(t)?`"${t.replace(/\\/g,`\\\\`).replace(/"/g,`\\"`)}"`:t}function _(e){return/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(e)?`cjk`:/[\p{L}\p{N}]/u.test(e)?`latin`:`symbol`}function v(e){return i.has(m(e).toLowerCase())}function y(e){return o.has(m(e).toLowerCase())}function b(e){let t=e.join(` `).toLowerCase();return/mono|courier|consolas|menlo/.test(t)?`mono`:/narrow|condensed|oswald|bebas/.test(t)?`narrow`:!/sans/.test(t)&&/serif|times|georgia|song|simsun|宋体|ming|mincho|playfair/.test(t)?`serif`:`sans`}function x(e,t){return e===`symbol`?p:e===`cjk`?t===`serif`?c:s:t===`mono`?f:t===`serif`?d:t===`narrow`?u:l}function S(e,t){return e.some(v)?[...e]:[...e,t===`mono`?`monospace`:t===`serif`?`serif`:`sans-serif`]}function C(e,t,n){let r=h(e);if(r.length===0)return null;let i=_(t),a=b(r),o=e=>v(e)||!y(e)&&n(e,i);if(o(r[0]))return null;let s=r.findIndex(o);if(s>=0)return S(r.slice(s),a).map(g).join(`, `);let c=x(i,a),l=c.findIndex(o);return(l>=0?c.slice(l):c.slice(-1)).map(g).join(`, `)}function w(e){if(typeof e.defaultView?.CanvasRenderingContext2D!=`function`)return()=>!1;let t=e.createElement(`canvas`).getContext(`2d`);if(!t)return()=>!1;let n=/Mac/i.test(e.defaultView?.navigator.platform??``),r=new Set([`microsoft yahei`,`microsoft yahei ui`,`微软雅黑`,`dengxian`,`等线`,`simhei`,`黑体`,`heiti sc`]),i=new Map;return(e,o)=>{if(n&&r.has(m(e).toLowerCase()))return!1;let s=o===`cjk`?`latin`:o,c=`${e}\u0000${s}`,l=i.get(c);if(l!==void 0)return l;let u=a[s],d=g(e),f=[`monospace`,`serif`,`sans-serif`].some(e=>{t.font=`72px ${e}`;let n=t.measureText(u).width;return t.font=`72px ${d}, ${e}`,Math.abs(t.measureText(u).width-n)>.01});return i.set(c,f),f}}function T(e,t,n=w(e)){let r=e.defaultView?.NodeFilter.SHOW_TEXT??4,i=e.createTreeWalker(t,r),a=new Map;for(let e=i.nextNode();e;e=i.nextNode()){let t=e.textContent?.trim(),n=e.parentElement;!t||!n||a.set(n,`${a.get(n)??``}${t}`)}let o=e.defaultView;for(let[e,t]of a){let r=o?.getComputedStyle(e).fontFamily||e.style.fontFamily;if(!r)continue;let i=C(r,t,n);i&&(e.style.fontFamily=i)}}function E(e){return`${Number(e.toFixed(2))}px`}function D(n){let r=E(n.width),i=E(n.height);return`
[${e}] * {
  scrollbar-width: none;
}
[${e}] *::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
@media screen {
  [${e}] {
    position: fixed;
    top: 0;
    left: 0;
    z-index: -1;
    transform: translateX(-200vw);
    pointer-events: none;
  }
}
@media print {
  body > :not([${e}]) {
    display: none !important;
  }
  [${e}] {
    position: static !important;
    transform: none !important;
  }
  html,
  body {
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  @page {
    size: ${r} ${i};
    margin: 0;
  }
  [${t}] {
    width: ${r};
    height: ${i};
    position: relative;
    overflow: hidden;
    break-after: page;
  }
  [${t}]:last-child {
    break-after: auto;
  }
}
`}function O(){return new Promise(e=>{typeof requestAnimationFrame==`function`?requestAnimationFrame(()=>e()):setTimeout(e,0)})}async function k(e,t){await e.fonts?.ready,T(e,t),await e.fonts?.ready;let n=Array.from(t.querySelectorAll(`img`),e=>typeof e.decode==`function`?e.decode().catch(()=>void 0):void 0).filter(e=>e!==void 0);n.length>0&&await Promise.race([Promise.all(n),new Promise(e=>setTimeout(e,r))]),await O(),await O()}async function A(r,i){let a=i.createElement(`style`);a.setAttribute(n,``),a.textContent=D(r.pageSize);let o=i.createElement(`div`);o.setAttribute(e,``),o.setAttribute(`aria-hidden`,`true`),o.setAttribute(`inert`,``);let s=[],c=!1,l=()=>{if(!c){c=!0;for(let e=s.length-1;e>=0;--e)s[e]?.dispose();o.remove(),a.remove()}};try{i.head.append(a),i.body.append(o);for(let e=0;e<r.pageCount;e+=1){let n=i.createElement(`div`);n.setAttribute(t,``),o.append(n);let a=r.renderPage(e,n);s.push(a),await a.ready}return await k(i,o),{dispose:l}}catch(e){throw l(),e}}export{A as renderPresentationToPrintHost};