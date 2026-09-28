# Website localization brief

The home page is adapted for each audience, not translated sentence by sentence.
`src/copy/<lang>.mjs` holds the 11 locale versions. `docs/content.mjs` holds the
user and developer guide. Keep their factual claims aligned with the app and
`PRODUCT.md`.

This approach follows the W3C definition of localization as adaptation to a
locale's language and cultural context, which includes examples, images and
presentation as well as words. The current hero image contains no embedded
text, so each language can use its own copy beside it.

## Voice

- Speak about a familiar moment first: an email to answer, a file to find, a
  calendar to check, or a spreadsheet to understand.
- Sound helpful and calm. Use short, natural sentences. Do not make Vunemi sound
  human or autonomous beyond its permissions. State the public 0.1.0 release
  accurately without implying that unfinished features are complete.
- Mention local model setup only after the everyday benefits. An in-app model
  download is the ordinary starting path; connecting an existing local model is
  an option.
- Describe Vunemi as an everyday assistant. State that the first release is for
  macOS as current availability, not as a permanent limit of the product. Do
  not announce Windows or Linux versions before they are planned and built.
- Lead with the two things people get: everyday help, and data that stays on
  the Mac. Then control (approval cards), undo, and the hard limits.
- Be precise about limits: scheduled tasks run while Vunemi is open; reading
  and acting use separate permissions; results depend on the model and the Mac.
  The macOS installer is on GitHub and is not yet notarized by Apple. The
  gallery screenshots come from the English interface with sample data and are
  labelled so in every locale; the hero demo is localized HTML, not a
  screenshot.
- Examples should sound like something a person would actually ask. Do not
  promise a connector or a side effect that has not been verified.

## Locale choices

| Locale | Address and tone | Editorial note |
| --- | --- | --- |
| tr | `sen`, conversational | Prefer `e-posta`, `dosya`, `takvim`, `sana sorar`; avoid literal English idioms and formal `ileti` in marketing copy. This is Vunemi's brand choice; Microsoft's Turkish writing guide uses `siz` for Microsoft products. |
| en | `you`, warm and direct | Reference voice, not a sentence template for other locales. |
| de | `du`, natural | Prefer everyday verbs over compound technical nouns. |
| fr | `vous`, approachable | Keep the polite register throughout, including examples. |
| es | `tú`, approachable | Use everyday phrasing; avoid literal “space in your day” metaphors. |
| it | `tu`, light | Prefer concrete actions to abstract claims. |
| pt | Brazilian `você` | Keep Brazilian terms and verb forms consistent. |
| ru | polite `вы` | Keep benefit claims grounded and concise. |
| zh | simplified Chinese `你` | Use natural short clauses rather than mirroring English punctuation. |
| ja | polite `です/ます` | Keep requests natural and avoid word-for-word English slogans. |
| ko | polite `-요/-습니다` | Use everyday product language, not literal English noun phrases. |

Product names such as Vunemi, Excel and Notes remain recognizable. Never use
Apple or Microsoft artwork in the site without a separate rights and brand
review. The hero demo is drawn in HTML from the app's own components; the
screenshot gallery shows the app itself.

## Review before each public update

1. Check each claim against the current packaged app, not only source or tests.
2. Review each locale independently with a native speaker. The current copy is
   an editorial first pass; no locale is marked native-speaker approved.
3. Check example prompts, register, clipping at phone width, links, metadata,
   and screen-reader labels. Ask reviewers to rewrite unnatural lines rather
   than approve literal translations.
4. Run `node website/docs/build.mjs --release-check` and inspect the
   resulting site before publishing. Publishing needs the user's approval.

Every locale has its own pre-rendered pages with localized title, description,
hreflang links and a shared link-preview image (`og.png`, no text).

## Research used for this brief

- [W3C: Localization vs. internationalization](https://www.w3.org/International/questions/qa-i18n)
  defines localization beyond literal translation, including cultural examples
  and visual presentation.
- [W3C: Internationalization quick tips](https://www.w3.org/International/quicktips/)
  advises checking images and examples for cultural fit, keeping text out of
  graphics, and naming languages in their own script.
- [Apple: Writing](https://developer.apple.com/design/human-interface-guidelines/writing)
  emphasizes audience-familiar words, clear action labels, and reading copy
  aloud to check that it sounds natural.
- [Microsoft: Simple and human brand voice](https://learn.microsoft.com/en-us/style-guide/brand-voice-above-all-simple-human)
  recommends warm, concise, jargon-free wording that gets to the point.
- [Microsoft: Turkish writing style](https://learn.microsoft.com/tr-tr/windows/apps/design/style/writing-style)
  recommends direct address, short text and active voice. Its `siz` rule is
  specific to Microsoft's voice and is not automatically Vunemi's rule.
