# Calculator animation

Twelve-second silent, illustrated replay of the independently verified local
`45383 × 564 ÷ 235 = 108919.2` workflow. It shows one conversation-scoped approval,
observed app control and real-result verification. It is an animation, not a
screen recording or a latency benchmark. No personal chat history is bundled.

All 11 website languages are included. Copy lives in
`website/src/calculator-demo-copy.mjs`; layout/timeline lives in `render.mjs`.

Build the standalone responsive preview:

    node website/assets/demos/calculator/build.mjs

Export MP4, WebM and PNG posters for every locale (requires local Playwright,
Chromium and ffmpeg):

    VUNEMI_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs VUNEMI_CHROME_PATH=/path/to/chrome node website/assets/demos/calculator/build.mjs --video

Generated files are in `website/public/demos/calculator/`. The interactive
preview accepts `?lang=tr` (or any supported locale), has pause/replay/scrubbing,
and shows a still result by default when reduced motion is requested.

Embedding example (replace `tr` with the current site locale):

```html
<video controls muted playsinline preload="none"
  poster="/demos/calculator/calculator-tr-poster.png"
  style="display:block;width:100%;aspect-ratio:16/9;border-radius:24px">
  <source src="/demos/calculator/calculator-tr.webm" type="video/webm">
  <source src="/demos/calculator/calculator-tr.mp4" type="video/mp4">
</video>
```

Do not force video autoplay when reduced motion is requested. The generated
preview handles this automatically. Website publication remains a separate
release action; the main product pages are not replaced by this standalone demo.

Publication timing: hold these assets for the next application update, as requested. No live website deployment was performed.
