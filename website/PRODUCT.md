# Vunemi 0.1.1: what it is and what it does

Source material for the website. Everything below describes the released
0.1.1 build (27 September 2026) and was checked against the app's code and
its live test log. The last section lists what the site must not claim.

## In one sentence

Vunemi is a personal assistant for the Mac that runs its AI model locally:
it reads files, mail and calendars, uses Mac apps and the web, and helps with
tasks without uploading conversations or documents to a Vunemi cloud for AI
processing. Services the user chooses to connect still exchange the data
needed for those tasks.

## Who it is for

People who want help with everyday computer work (finding a file, summarising
the day's mail, adding a meeting, filling a spreadsheet, looking something up)
without writing scripts, and without sending their private data to a cloud AI.

## Principles (the product's promises)

- **Local first.** The model runs on the Mac, through Vunemi's built-in engine
  or a model server the user already has (LM Studio, Ollama, llama.cpp).
  Vunemi does not provide a cloud AI processing account. If the user connects
  Gmail, Outlook, websites or another online service, that service still
  receives the data needed for the requested action under its own terms.
- **Everything starts switched off.** Each connection (Files, Mail, Calendar,
  Browser…) is off until the user turns it on. A connection that is off is
  invisible to the model: its tools cannot be called at all.
- **The user approves.** Anything beyond reading goes through an approval
  card that says exactly what will happen. How often Vunemi asks is set in
  Settings › Permissions.
- **Undo.** Changes Vunemi makes (files written or moved, calendar events,
  reminders, notes, mail moved) are listed in the Activity log with an Undo
  button. Deleting means the Trash, never gone for good.
- **Hard limits, at every setting.** Vunemi never types passwords, card, bank
  or ID numbers; never solves CAPTCHAs; never pays; never deletes anything
  permanently. At those steps it hands over to the user.
- **macOS decides too.** macOS permission prompts, Keychain prompts and
  Microsoft Office's "Grant Access" window are always answered by the user.

## Getting started

1. Download the disk image from GitHub (Apple Silicon, macOS 14 or later).
2. Drag Vunemi into Applications and open it. The build is signed but not
   notarized by Apple: if macOS refuses, System Settings › Privacy & Security
   › Open Anyway. If opened straight from the disk image, Vunemi offers to
   move itself to Applications.
3. Choose a model. The first screen recommends one that fits the Mac's memory
   and downloads it; smaller models, a Hugging Face search and "I use LM Studio
   or Ollama" are one click away. A GGUF file already on the Mac can be added.
4. Turn on only the connections you need, in Settings › Connections.

## Features

### Chat and tasks

- Ask in plain language; Vunemi works step by step and shows each step.
- **Plan card:** for a multi-step task it can show the plan first; the user
  can go ahead, edit the steps or cancel.
- **Approval cards** for every change, showing what, where and to whom.
- **Queue and interrupt:** type the next request while a task runs; it waits
  its turn, or "Interrupt" stops the current task and does it at once.
- **Emergency stop:** ⌘⇧Esc stops a running task, even when Vunemi is locked.
- **Recovery:** if Vunemi closes mid-task, it says how far it got and offers
  to continue carefully, asking before any step that changes or sends.
- **Long conversations:** older parts are condensed automatically so the
  model keeps room to work ("Compact now" is also available).
- **Images:** attach pictures or screenshots; models with a vision part can
  see them. Without one, Vunemi can still read text in an image on the Mac.
- **Answers** are plain text and Markdown (lists, tables, code).

### Meetings

- Recording starts from the Meetings page only, when the user presses Record.
- Vunemi captures the selected microphone and Mac system audio separately on macOS 14.2 or later.
- It writes a local transcript and summary. After a successful summary, the audio files go to the Trash.
- If transcription fails, it keeps the audio and offers a retry. Recording is not available to agent tools or scheduled tasks.

### Projects and sessions

- Conversations are kept as sessions in the sidebar.
- A **project** is a folder: in it, Vunemi reads, creates and edits that
  work's files, and every change can be undone. Removing a project from the
  list leaves the folder untouched.

### Voice

- **Dictation** on the Mac with a local speech model (Whisper); nothing is
  sent online. The spoken language is detected automatically.
- **Voice chat:** hands-free mode that sends when you stop talking, reads the
  answer aloud and listens again. Clear states: Listening, Processing,
  Speaking, Acting, Your turn.

### Connections

| Connection | What it does | Parts the user switches on separately |
|---|---|---|
| **Files** | Desktop, Documents and Downloads only | Reading · Writing (undoable, deletes go to Trash) · Converting (ffmpeg, sips, textutil; no shell) |
| **Browser** | A browser inside Vunemi's window, separate from the user's Chrome | Reading pages · Interaction (click, type, fill forms) |
| **Flights and hotels** | Searches Google Flights and Trivago and shows the options as cards; choosing one opens its offer beside the chat | Google Flights · Trivago (each off until switched on; a search asks first) |
| **Mail** | Gmail (app password), any IMAP/SMTP account, Outlook (with the user's own Microsoft Entra app ID) | Reading · Drafts · Sending · Organising (archive, folders, Trash, read) |
| **Calendar** | The Mac's calendars, including Google or Outlook calendars added in macOS Internet Accounts | Reading · Adding and changing (undoable) |
| **Reminders** | The Mac's reminders | Reading · Adding and changing (undoable) |
| **Mac apps** | Notes, Finder, Word, Excel, PowerPoint, Music, Photos, Safari, Chrome, Contacts, Messages, and other scriptable apps, without clicking the screen | Each app has its own switch |
| **Shortcuts** | Lists the user's Apple Shortcuts and runs one | Every run asks first |
| **Desktop** | Reads app windows and, if allowed, clicks and types (macOS Accessibility) | Reading · Control (the widest privilege) |
| **Scheduled tasks** | Tasks set up in chat that run at set times | Setting up and managing |
| **Custom connections** | Any MCP server the user adds (command or address); its secrets are kept in the Vault | Per connection |

Details worth telling:

- **Browser:** the user can browse in the same panel, sign in once and stay
  signed in, and press **Take control** at any moment; the agent stops before
  its next step. At sign-in pages, CAPTCHAs and payments it hands over.
- **Flights and hotels:** the route or destination, dates and traveller count
  go to Google or Trivago, and the approval card says so. Vunemi does not
  book or pay; an offer page opened from a card declines optional cookies
  (Google "Reject all", Trivago "Essential cookies only"). No Python or other
  runtime is needed.
- **Mail:** every outgoing message waits **45 seconds** in the Outbox and can
  be taken back. One-time codes and sign-in links are never shown to the
  model. The mail password is kept in the Vault; with Outlook, the user signs
  in on Microsoft's own page.
- **Calendar:** nobody can be invited to an event; no password is stored.
- **Messages:** sends an iMessage only to the recipient and text shown on the
  card, after approval.
- **Office:** reads and writes Excel ranges, reads Word documents and exports
  them to PDF, and reads a PowerPoint outline; if a workbook is open in Excel,
  it asks the user to close it first.
- **Off limits:** Terminal, password managers, Keychain Access, System
  Settings, script editors and Vunemi itself can never be driven.

### Scheduled tasks

- Ask in chat, e.g. "summarise my calendar every morning at 9"; a card shows
  the name, the time and the task, and the task is set up only if approved.
- Suggested tasks: **Morning summary** (today's meetings and mail waiting for
  a reply, as a notification) and **Mail waiting for my reply**.
- Scheduled tasks **never send, delete or pay**: those tools aren't even
  loaded when a task runs on schedule. Tasks can be switched off, run now or
  deleted at any time. They run while Vunemi is open.

### Safety and control

- **Permissions:** four presets (Watch and suggest · Plan and propose · Act
  with approval · Act on its own) and a per-kind setting: Reading, Changes on
  this computer, Hard-to-undo actions, Sending things out. Financial actions
  are always off.
- **Vault:** keys and passwords that tools use are encrypted with a key in the
  Mac's Keychain. The model only ever sees the name; if a value shows up on a
  page, it is replaced with its name before the model sees it.
- **Activity log:** everything the agent did, kept on the Mac, with Undo.
- **Made by Vunemi:** files it wrote, drafts it saved, events it added and
  files it downloaded, with Open and Show in Finder.
- **Outbox:** messages waiting to be sent, and what happened to each.
- **App lock:** Vunemi can be locked with Touch ID or the Mac password.
- **Saved preferences:** Vunemi remembers a preference only when asked, after
  approval; each can be deleted. A preference never grants a permission.
- **Data controls:** forget a session, or "Forget everything" (accounts,
  vault, permissions, log, sessions, browser data).

### Languages

The app is available in 11 languages: Turkish, English, German, French,
Spanish, Italian, Portuguese, Russian, Chinese, Japanese and Korean.

### Open source

Source code on GitHub under GPL-3.0; the Vunemi name and logo are not
covered by that license (TRADEMARKS.md). Contributions welcome with a DCO
sign-off.

## Links

- Repository: https://github.com/capitansuat/vunemi
- Release: https://github.com/capitansuat/vunemi/releases/tag/v0.1.1
- Direct download (for the site's button):
  https://github.com/capitansuat/vunemi/releases/latest/download/Vunemi-0.1.1-arm64.dmg
  (133 MB; SHA-256 4c675d3a0fac69aaaab1c69a214809e45867351f8815c6bee0d028bd63f696c2)
  The file name carries the version, so this link changes with each release.
  A link that never changes: https://github.com/capitansuat/vunemi/releases/latest
  (the release page, with the DMG and install steps).

## What the website must not claim

- Not notarized by Apple (signed only); not in the Mac App Store.
- Apple Silicon only; macOS 14 or later. No Windows, no Intel Macs.
- Tasks, including scheduled ones, run only while Vunemi is open.
- "Sign in with Google" and "Sign in with Microsoft" are not active in 0.1.1:
  Gmail uses an app password; Outlook needs the user's own Entra app ID.
- The automation library and shortcut builder are designed but not in 0.1.1.
- Result quality, speed and image understanding depend on the model and the
  Mac; a small model makes mistakes on complex tasks. Not tested yet on an
  8 GB Mac.
- No night-mode switch yet (the app follows macOS light/dark).
- Don't show personal data in screenshots; the screenshots in
  `assets/screenshots/` use synthetic data only.
