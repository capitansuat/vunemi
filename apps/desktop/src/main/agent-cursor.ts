/**
 * The agent's cursor, drawn on top of the page in the built-in browser so
 * the user sees where it is about to click or type.
 *
 * Runs in an isolated JS world: the page's own scripts can't see or call it.
 * The overlay is a closed shadow root on <html> (outside <body>, so it never
 * shows up in page_read's innerText), aria-hidden (so it stays out of the
 * accessibility tree the agent reads) and pointer-events:none (so it never
 * intercepts a click or the hit-test before one).
 */

import type { PointerEvent } from "@vunemi/browser";

export const CURSOR_WORLD_ID = 1917;

const CSS = `
:host { all: initial; }
.c { position: fixed; left: 0; top: 0; transition: transform 260ms cubic-bezier(.2,.7,.3,1), opacity 300ms; will-change: transform; }
.c svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
.tag { position: absolute; left: 20px; top: 20px; padding: 2px 8px; border-radius: 999px; background: #ff7a45; color: #fff;
  font: 600 11px/16px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; white-space: nowrap; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 2px solid #ff7a45;
  animation: r 600ms ease-out forwards; }
@keyframes r { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .c { transition: opacity 300ms; } .ripple { animation-duration: 1ms; } }
`;

const ARROW = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5 20 12l-7.2 1.6L9.5 21z" fill="#ff7a45" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/** A script for executeJavaScriptInIsolatedWorld; resolves once the cursor has arrived. */
export function cursorScript(p: PointerEvent, name = "Vunemi"): string {
  return `(() => {
  const p = ${JSON.stringify(p)};
  const name = ${JSON.stringify(name)};
  let st = window.__vunemiCursor;
  if (!st || !st.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = ${JSON.stringify(`<style>${CSS}</style><div class="c">${ARROW}<span class="tag"></span></div>`)};
    document.documentElement.appendChild(host);
    const c = root.querySelector(".c");
    const x = innerWidth / 2, y = innerHeight / 2;
    c.style.transform = "translate(" + x + "px," + y + "px)";
    st = window.__vunemiCursor = { host, root, c, tag: root.querySelector(".tag"), timer: 0 };
  }
  const short = (s) => (s.length > 28 ? s.slice(0, 27) + "…" : s);
  st.c.style.opacity = "1";
  if (p.kind === "key") st.tag.textContent = name + " · " + p.key;
  else if (p.kind === "type") st.tag.textContent = name + " · \\u2328 " + short(p.text);
  else st.tag.textContent = name;
  if (p.kind !== "key") st.c.style.transform = "translate(" + (p.x - 4) + "px," + (p.y - 3) + "px)";
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.c.style.opacity = "0"; }, 6000);
  return new Promise((done) => setTimeout(() => {
    if (p.kind === "click") {
      const r = document.createElement("div");
      r.className = "ripple";
      r.style.left = p.x + "px";
      r.style.top = p.y + "px";
      st.root.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }
    done(true);
  }, p.kind === "key" ? 120 : 300));
})()`;
}
