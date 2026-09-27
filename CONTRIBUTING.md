# Contributing to Vunemi

Thank you for helping. A few things keep the project safe and easy to review.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree
  on the approach.
- Keep a change to one purpose. Small pull requests are reviewed faster.

## Rules the code must keep

Vunemi acts on people's own computers, so some limits are not negotiable:

- The agent never enters passwords, card, bank or ID numbers, never solves
  CAPTCHAs, never pays and never deletes anything permanently.
- macOS permission prompts, Keychain prompts and Vunemi's approval cards are
  answered by the user, never by code.
- Connections start switched off. Anything beyond reading goes through an
  approval card.
- No secrets in the repository, and no personal data in tests: use
  synthetic values such as `test@example.com`.
- Don't copy code from projects whose license is not compatible with
  GPL-3.0.

## User-facing text

Every string the user sees lives in the catalogs under
`packages/i18n/src/messages/`, in all 11 languages (tr, en, de, fr, es, it,
pt, ru, zh, ja, ko). Code comments and model-facing text are in English.

## Checks

Run these before opening a pull request:

```bash
pnpm typecheck
pnpm test
```

## Sign your commits (DCO)

By contributing you certify the [Developer Certificate of
Origin](https://developercertificate.org/): you wrote the change, or have the
right to submit it under this project's license. Add a sign-off line to every
commit:

```bash
git commit -s -m "Describe the change"
```

This adds `Signed-off-by: Your Name <you@example.com>` to the message.
Contributions are accepted under the GNU General Public License v3.0.
