# Vunemi website

`public/` is the static content served by the `vunemi-site` Cloudflare Worker.
Every page is pre-rendered per language, so search engines and link previews
see real text:

- `/<lang>/`, `/<lang>/features/`, `/<lang>/screens/`, `/<lang>/download/`, `/<lang>/support/` for
  the 11 UI languages, generated from `src/`;
- `/docs/<lang>/`, the guide, generated from `docs/content.mjs`;
- `/`, `/features/`, `/screens/`, `/download/`, `/support/` and `/docs/` are small redirect
  pages that honour `?lang=`, the language last picked, then the browser's.

Files under `public/<lang>/`, `public/docs/` and the redirect pages are
generated; edit the sources instead.

## Sources

- `src/release.mjs`: the version the site offers, its asset, size and SHA-256.
  Update every field together for a new release, after checking the asset on
  GitHub.
- `src/copy/<lang>.mjs`: all product-page text. `en.mjs` is the reference; the
  build fails if another locale's shape differs or a text is empty. Facts follow
  `PRODUCT.md` (what Vunemi does, and what the site must not claim).
- `src/pages.mjs`: page templates, including the hero demo (a small, localized
  Vunemi window that plays plan → approval → undo).
- `src/images.py`: scales the reviewed screenshots in `assets/screenshots/`,
  cuts the hero crop and draws `og.png` (with the app icon from
  `apps/desktop/build/`).
- `public/site.css`, `public/site.js`: shared style, language menu, scroll
  reveal and the demo playback (all content is visible without JavaScript and
  with reduced motion).
- `src/support-copy.mjs`: localized support form text.
- `worker/index.mjs`: form endpoint; validates the origin and fields, applies a
  rate limit, verifies Turnstile server-side, then sends to the verified
  `support@vunemi.com` routing address. Cloudflare Email Routing forwards it
  to the private destination configured outside this website. The visitor receives no automatic
  reply and no GitHub issue is created automatically. Do not log form content.

`public/working-day.jpg` is an editorial photo with a blank laptop screen; the
story section overlays the real `01-home.png` in HTML. Keep that overlay
aligned when changing the photo or its layout.

## Build and check

```bash
python3 website/src/images.py        # only when screenshots change
node website/docs/build.mjs --build
node website/docs/build.mjs --release-check
node --test website/worker/index.test.mjs
```

`--check` fails when generated pages are stale. `--release-check` also compares
the recorded review (`docs/content.mjs`) with this repository's app code: the
app version must match, and no app code may have changed since the reviewed
commit. It does not
prove that translations are idiomatic or that a connection works live.

Review the pages at desktop and phone widths before publishing.

## Deploy

From `website/`, `npx wrangler deploy` publishes `public/` to the `vunemi-site`
Worker (vunemi.com and www.vunemi.com, see `wrangler.jsonc`). It runs the
release check first and stops if it fails.

## Screenshots

The gallery shows eight real screens from the English app, captured with
sample data: plan card, browser answer, chat home, permissions, connections,
scheduled tasks, vault and model. Recheck each public image for personal
data, tokens, account identifiers and misleading test states before a
release.

The support form additionally needs the `TURNSTILE_SECRET` Worker secret. The
public Turnstile site key is in `src/pages.mjs`; never put the secret in source
or static assets. Recheck a real form submission in the destination Gmail
account after each email-binding or sender-domain change. The browser's
success message only establishes that the Email Service accepted the send;
it does not prove inbox delivery.
