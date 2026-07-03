# Trish — Voice Web Assistant

A Chrome extension (Manifest V3) that lets blind and low-vision users browse
the web by voice: it reads pages, answers questions about their content, and
takes actions — clicking, navigating, and filling forms — through a spoken
conversation.

## How it works

```
Side Panel  ── mic ⇄ speech + tool-call events ──►  Gemini Live API (primary)
    │                                                 or OpenAI Realtime (secondary)
    │ chrome.tabs.sendMessage
    ▼
Content Script (per tab)
    - builds a compact snapshot: interactive elements get ids (e1, e2, ...)
    - executes actions: click, fill (React-safe), select, scroll, press Enter
    - watches aria-live regions and forwards page announcements
```

The model receives condensed page snapshots (not raw HTML), decides which tool
to call (`click_element`, `fill_field`, `get_form_fields`, ...), the content
script executes it against the live DOM, and the result is spoken back.

## Power mode (Chrome DevTools Protocol)

Trish also carries a CDP layer (`lib/cdp.js`, via the `chrome.debugger` API) —
the same protocol DevTools and Playwright use — for sites that ignore
synthetic events:

- `click_element_trusted` — a real, trusted mouse click at the element's
  coordinates. Works on stubborn React apps, canvas UIs, etc.
- `type_text_trusted` — trusted keyboard input (`Input.insertText`), with
  optional select-all-and-replace and press-Enter-after. Works in rich text
  editors and Google Docs-style apps where `fill_field` fails.
- `look_at_page` — captures a screenshot and attaches it to the conversation
  as an image, so the model can describe photos, charts, maps, and canvas
  content that the text snapshot can't represent.

The model tries the normal DOM tools first and escalates to these only when
needed. Password fields are refused in trusted typing just like in normal
filling.

Trish also uses CDP to handle **native browser dialogs** — `alert`, `confirm`,
and `prompt`. These freeze the page (and the content script) until answered, so
Trish attaches the debugger at the start of a voice session, catches each dialog
via `Page.javascriptDialogOpening`, reads it to the user, and resolves it with
the `handle_dialog` tool (accept/cancel, or submit text for a prompt). Confirm
dialogs are only accepted after the user agrees. A `beforeunload` ("Leave
site?") dialog — including the ones redirect/interstitial pages raise — is
**accepted automatically** so navigation is never blocked; it is never shown to
the model. As a safety net, any dialog left unanswered for 30 seconds is
auto-dismissed so a tab can't stay frozen. Because attachment begins at session
start, Chrome shows the "started debugging this browser" banner for the whole
session — that's expected and harmless; Trish detaches when the session ends.

## Setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select this folder.
2. Click the Trish icon (or press **Alt+V**) to open the side panel.
3. Open **Settings** from the panel and paste your Gemini API key
   (from aistudio.google.com/apikey) — Gemini is the default provider for both
   voice and vision. (OpenAI is available as a secondary provider; add that key
   only if you switch to it.) Optionally fill in your profile (name, address,
   phone) so "fill in my shipping address" works.
4. Press **Start voice session** (or **Alt+Shift+V**). Allow microphone
   access when Chrome asks — this is asked once for the extension.
5. Talk: *"What's on this page?"*, *"Read the article"*, *"Click the login
   button"*, *"Fill this form for me"*, *"Search for wireless headphones"*.

**Read page aloud** in the panel works offline and free (Chrome's built-in
text-to-speech) — no API key needed.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Alt+V | Open the Trish side panel |
| Alt+Shift+V | Start / stop the voice session |

Reassign them at `chrome://extensions/shortcuts`.

## Safety and privacy

- **Confirmation gate** — the model is instructed to read back and get spoken
  confirmation before anything irreversible (orders, payments, deletions,
  sending messages).
- **Passwords** — Trish never fills, reads, or listens for passwords. It
  focuses the field and asks you to type. Password field contents are never
  included in page snapshots.
- **Profile vault** — your saved details live only in `chrome.storage.local`
  on this computer and are sent to the AI provider only when a form-filling
  tool call needs them.
- **Cost** — the OpenAI Realtime API bills per audio minute. Use the offline
  "Read page aloud" button for plain reading to avoid burning API time.

## Project layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest: side panel, commands, permissions |
| `background/service-worker.js` | Opens the panel, relays keyboard commands |
| `sidepanel/` | Audio session host, transcript UI, tool routing |
| `content/content.js` | Page snapshots, action execution, live-region watch |
| `lib/tools.js` | Tool schemas + executor (side panel → content script) |
| `lib/cdp.js` | Trusted input + screenshots via chrome.debugger (CDP) |
| `permission/` | One-time microphone permission setup page |
| `lib/provider-gemini.js` | Gemini Live over WebSocket (primary voice) |
| `lib/provider-openai.js` | OpenAI Realtime over WebRTC (secondary voice) |
| `options/` | API keys, models, voice/language, profile vault |

## Provider notes

- **Gemini is the primary provider** for both voice and vision; OpenAI is a
  drop-in secondary (switch on the Settings page). Both `provider-*.js` files
  expose the same interface, so `sidepanel.js` is provider-agnostic.
- **Voice (Gemini Live).** `lib/provider-gemini.js` opens a WebSocket to
  `…/BidiGenerateContent`, sends a `setup` message with the native-audio model,
  streams 16 kHz PCM16 mic chunks up, and plays the 24 kHz PCM16 audio the model
  speaks back (native TTS). Tools are sent as `functionDeclarations` and
  answered with `toolResponse`; input/output transcriptions drive the
  transcript. Default model `gemini-3.1-flash-live-preview` —
  **preview names rotate, so update it on the Settings page if a session won't
  connect.** OpenAI's path stays on `gpt-realtime` via WebRTC.
- **All vision** runs on a separate, stronger model via one-off calls in
  `lib/vision.js`, matching the selected provider: **Gemini `gemini-2.5-pro`**
  (`…/models/{model}:generateContent`) or OpenAI `gpt-5`
  (`chat/completions`). It powers `look_at_page` (describe the screen),
  `find_on_screen` / `click_on_screen` (locate an element by description and get
  exact center coordinates / click it), and `solve_captcha` (challenge text plus
  tile/checkbox/Verify coordinates). All coordinates come back in the
  screenshot's CSS-pixel space, so they feed straight into
  `click_at_coordinates` / `type_at_coordinates` / the trusted click.
  `click_on_screen` is the reliable way to hit small or awkward targets the DOM
  tools miss — e.g. the "English" button in a site's language-selection modal.

## Roadmap

- [x] Vision: `look_at_page` screenshots for images/canvas (via CDP)
- [x] Trusted input for sites that ignore synthetic events (via CDP)
- [x] Gemini Live provider implementation (now the primary provider)
- [ ] Heading/landmark jump commands executed locally (no API round trip)
- [ ] "What did you just do?" action-history replay
- [ ] Encrypt the profile vault at rest
- [ ] Multi-tab awareness ("switch to the cart tab")

## License

Released under the [MIT License](LICENSE) © 2026 Hareram Ray.

## Known limitations

- Cannot operate on browser-internal pages (`chrome://…`, Web Store).
- Complex custom widgets (canvas apps, some ARIA comboboxes) may not expose
  useful element names; `look_at_page` lets the model see them, but acting on
  them may still require the trusted-click tool with visible coordinates.
- The mic permission prompt itself is a browser dialog Trish cannot read
  aloud — a sighted helper may be needed once during setup.
