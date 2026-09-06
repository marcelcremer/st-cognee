# SillyTavern UI/DOM notes

Findings from actually investigating SillyTavern's source (cloning
`SillyTavern/SillyTavern` and `Samueras/GuidedGenerations-Extension` locally
and reading them directly, since web fetches of the large core files kept
truncating before reaching the relevant part) while building this
extension's toolbar/menu UI. This is general SillyTavern knowledge, not
specific to Psychograph — worth checking before building UI for any future
layer, and worth updating if something here turns out to be version-specific
or wrong.

## Extension loading

Third-party extension root (`manifest.json`, `index.js`, `settings.html`,
`style.css`) is loaded from
`public/scripts/extensions/third-party/<name>/`. Import paths, counted from
that directory:

| Import | Path | Depth reasoning |
|---|---|---|
| `extension_settings`, `getContext` | `../../../extensions.js` | `extensions.js` lives at `public/scripts/extensions.js` |
| `saveSettingsDebounced` | `../../../../script.js` | `script.js` lives at the `public/` root — one level *higher* than the above |
| `eventSource`, `event_types` | `../../../events.js` | `events.js` lives at `public/scripts/events.js` — **same depth as `extensions.js`**, not `script.js`. Easy off-by-one: an extra `../` here resolves to the domain root and 404s. |
| `ConnectionManagerRequestService` | `../../shared.js` | `public/scripts/extensions/shared.js` — one level *shallower* since it's inside `extensions/` itself |

Settings HTML is injected via `$("#extensions_settings2").append(fetchedHtml)`.

## Connection Manager / profiles

Profiles live in `extension_settings.connectionManager.profiles` (array) and
`.selectedProfile` (currently active profile ID). There's no documented
public API for a third-party extension to read the list for its own
dropdown — reading the settings object directly is the established (if
informal) convention; don't touch `.selectedProfile` unless you actually
want to change the user's global active connection.

Profile shape: `{id, mode: 'cc'|'tc', name, api, preset, model, proxy,
exclude, ...}` plus mode-specific fields (`instruct`, `context`, `api-url`,
`secret-id`, etc.). `mode` is `'cc'` for Chat Completion, `'tc'` for Text
Completion — branch on this before building a request, since the two paths
support different override fields (see below).

Events: `CONNECTION_PROFILE_LOADED/CREATED/UPDATED/DELETED` — useful to
re-populate a dropdown live if the user edits profiles while your settings
panel is open.

## `ConnectionManagerRequestService` (from `scripts/extensions/shared.js`)

`static sendRequest(profileId, prompt, maxTokens, custom, overridePayload)`
— `prompt` can be a plain string or a chat-message array. `overridePayload`
is spread directly into the params object handed to
`ChatCompletionService.processRequest` (mode `'cc'`) or
`TextCompletionService.processRequest` (mode `'tc'`). `getProfile(profileId)`
resolves a profile object (throws if not found).

### Schema/grammar enforcement is NOT guaranteed

Passing `response_format`/`json_schema` in `overridePayload` does not
reliably force structured output end-to-end:

- **Text Completion (`tc`)**: SillyTavern's own `createTextGenGenerationData()`
  only forwards the `json_schema` param when the profile's backend type is
  `TABBY` or `LLAMACPP` (`guided_json` for Aphrodite). Any other type
  (including a generic/OpenAI-compatible text-completion source) silently
  drops it — no error, the field is just absent from the outgoing request.
- **Chat Completion (`cc`)**: no evidence of `response_format`/`json_schema`
  support in SillyTavern's chat-completion payload builder at all.

Confirmed by testing directly (curl) against a real backend: when
enforcement *does* work, it's real grammar-constrained decoding and it
**enforces the schema's property declaration order** — a field like
`reasoning` declared first forces the model to produce it (i.e. "think")
before any answer fields that follow. That's a genuinely useful lever for
small/local models: put a debug-only reasoning field first in both the
schema and any JSON example shown in the prompt.

Because enforcement can silently no-op, always *also* instruct the model in
plain prompt text to reply with a bare JSON object, and parse defensively
(strip markdown code fences, extract the first `{...}` block) rather than
assuming `response_format` alone guarantees valid output.

## Chat message events

`MESSAGE_SENT` (user message added), `MESSAGE_RECEIVED` (character message
added), `MESSAGE_SWIPED` (active swipe changed). Rather than trust whatever
argument each event passes, just read `getContext().chat[chat.length - 1]`
— simpler and correct regardless of the exact per-event argument shape.

## Adding buttons: wand menu vs. your own toolbar row

**The wand menu (`#extensionsMenu`)** is where bundled first-party
extensions add controls, but each of them gets a *pre-declared, dedicated*
container div already sitting inside the dropdown in core `index.html`
(e.g. `#caption_wand_container`, `#translate_wand_container`) — their JS
just fills content into an existing slot. Third-party extensions get no
such reserved slot; appending directly to `#extensionsMenu` is possible, but
SillyTavern closes/hides the whole dropdown as soon as *any* item inside it
is clicked — before your own click handler can reliably read its element's
position (`jQuery.offset()` returns `{top:0,left:0}` for anything under a
now-`display:none` ancestor). This makes the wand menu a poor home for
anything that needs to open its own follow-up UI (a submenu, a popup).

**`#nonQRFormItems`** is *not* a generic icon toolbar — it's the actual
message-composer row itself: `#leftSendForm` (options/hamburger icon) →
`#send_textarea` (the input box) → `#rightSendForm` (continue/pause/stop/
impersonate/send icons). Appending a button directly into it just wedges a
4th item in alongside the textarea.

**The pattern that actually works** (confirmed by reading
GuidedGenerations-Extension's source, which renders correctly in practice):
create your own container div and insert it as a **sibling immediately
after** `#nonQRFormItems`:

```js
const nonQrFormItems = document.getElementById('nonQRFormItems');
const myContainer = document.createElement('div');
nonQrFormItems.parentNode.insertBefore(myContainer, nonQrFormItems.nextSibling);
```

This lands your row *below* the composer, not squeezed inside it.
`#send_form`'s children stack vertically — each independently-inserted
container becomes its own row. There's no shared row for multiple
extensions' buttons to land in together unless you deliberately couple to
another specific extension's container ID (fragile — avoid; it breaks the
moment that extension is absent or changes its own markup).

## The `hidden` attribute pitfall (the expensive lesson)

The HTML `hidden` attribute works via the browser's default (UA) stylesheet
rule `[hidden] { display: none }`, which has ordinary CSS specificity
(0-1-0 — the same weight as a single class selector). **Any author-level
CSS rule of equal or higher specificity that sets `display` on the same
element silently wins, with no warning.** If your toggled element reuses a
host app's own class (e.g. SillyTavern's `.list-group`) and that app's
stylesheet happens to set `display` on that class, `hidden` never actually
hides anything — the element just sits wherever it was last positioned (or
its unset default, often near the top-left of the page).

Symptoms this produces: an element that "always renders in the wrong
place" and "doesn't visibly close" on a second toggle — both are just the
same underlying non-hiding, not two separate bugs.

**Fix:** don't rely on the `hidden` attribute on any element that also
carries a host app's own class. Use your own dedicated class with an
explicit `display: none` base rule plus a `.shown`/`.open` class override,
and toggle visibility via `classList.add/remove` (or jQuery
`.addClass`/`.removeClass`) — never `.prop('hidden', ...)`. This is exactly
what GuidedGenerations does; it never touches the `hidden` attribute at
all.

## Positioning a floating submenu

`position: absolute` (not `fixed`) on an element appended directly to
`<body>`, with its `top`/`left` computed from
`anchorElement.getBoundingClientRect()` **plus** `window.scrollX`/
`window.scrollY` (the rect is viewport-relative; an absolutely-positioned
body child resolves against the document) — this is the pattern
GuidedGenerations uses successfully. `transform: translateY(-100%)` opens
the menu upward from the anchor without needing to pre-measure its
rendered height.

## Character/persona description

`getContext().getCharacterCardFields({chid})` (no `chid` = current
character) returns `{description, persona, personality, scenario, system,
jailbreak, mesExamples, firstMessage, alternateGreetings, version,
charDepthPrompt, creatorNotes}` — already macro-substituted and trimmed.
`.description` is the character card's description field; `.persona` is
`power_user.persona_description` (the user's persona). This is the clean,
documented way to get "what does the card/persona actually say," instead of
reaching into `characters[chid]` by hand.

## Slash commands / swipe from JS

`context.executeSlashCommandsWithOptions(command)` runs raw stscript
(`/inject`, `/continue`, `/trigger`, `/flushinject`, etc.) from extension
code. `context.swipe.right()` (SillyTavern ≥ 1.13.0) triggers a new swipe
generation programmatically.

## Debugging tip: clone, don't fetch

Web-fetching SillyTavern's large core files (`index.html`, `script.js`,
`openai.js`) for a specific detail is unreliable — the content gets
summarized/truncated before reaching the relevant section, especially past
a few thousand lines. `git clone --depth 1 <repo>` locally and `Grep`/`Read`
directly is far more reliable for verifying exact markup or behavior than
repeated lossy fetches of the same file.
