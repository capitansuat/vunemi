# Craft OOXML reader regression fixtures

Copied unchanged from `research/rea-office-2026-10-14/craft/fixtures/` on 2026-10-15. These are synthetic Office fixtures produced by the pinned local Craft engines during the 2026-10-14 Office investigation, not user documents.

`grid-source.xlsx` has SUM(B2:B3) cached as 30; `grid-edited.xlsx` has cached value 70; `grid-errors.xlsx` contains an error cell; `deck-source.pptx` includes actual slide text and speaker notes. Reader tests validate actual archive contents, not creation arguments.

SHA256:

- `grid-source.xlsx`: `60049d0d56d4e61a994a8be7cb6a2afaa38bb694b9f4449142e4f8955dca6cbe`
- `grid-edited.xlsx`: `dcc22e4e8254f80ef1407c18a12a7857ceb18ceacca31a197339fcf6462c9748`
- `grid-errors.xlsx`: `df8d1bf0d6558feb13287a52214dcd20f036adfb872856a814889f07380796b1`
- `deck-source.pptx`: `83c369b16c168f0e68ac379e18ab70839565ec272a94b85f435ec302e574d5dc`
