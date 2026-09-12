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

The table counts from the extension root. A file in a subdirectory needs one
extra `../` per level, which is how the off-by-one above happens in practice —
so in this extension every one of these imports is re-exported from
`src/sillytavern.js` and nothing else imports SillyTavern directly.

Settings HTML is injected via `$("#extensions_settings2").append(fetchedHtml)`.
An extension is loaded as an ES module, so relative imports between its own
files work unmodified — no bundler needed to split it across directories.

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
- **Chat Completion (`cc`)**: supported, but under a different field than the
  OpenAI wire format. The client sends `json_schema: {name, value, strict}`
  (note `value`, not `schema`) and `src/endpoints/backends/chat-completions.js`
  translates it per provider — `response_format` for OpenAI-compatible sources,
  `input_schema` on a forced tool call for Claude, `responseSchema` for Gemini,
  and a system message spelling out the schema for the ones that support
  nothing (AI21, DeepSeek). A generic fallback at the end of the handler
  covers every source that didn't set `response_format` itself, so `CUSTOM`
  (a self-hosted OpenAI-compatible endpoint) is covered too. Sending
  `response_format` directly does *not* work: the server builds its request
  body from named fields and never passes it through.
- On the `cc` path only, `ChatCompletionService` also `JSON.parse`s the reply
  when `json_schema` was in the request, so `response.content` comes back as
  an **object** rather than a string. Parse defensively either way.

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

## Adding a button to every message

`#message_template` is the markup every message is rendered from, and
`.extraMesButtons` inside it is the row behind the "..." message-actions hint.
A button added to the template shows up on every message rendered afterwards -
including all of them again after a chat switch, since the chat is re-rendered
from the template - so an extension also has to add it to `#chat .mes
.extraMesButtons` for the messages already on screen.

Use `mes_button` for the styling the row expects, and read the message index
from the enclosing `.mes` element's `mesid` attribute (`Number($(this)
.closest('.mes').attr('mesid'))`), which is what SillyTavern's own handlers do.
Bind the click delegated from a stable ancestor rather than to the buttons
directly: `#chat` is replaced wholesale on every re-render.

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

## Event listeners are awaited, and that puts them on the critical path

`EventEmitter.prototype.emit` (`public/lib/eventemitter.js`) awaits every
listener, one after another, each in its own try/catch:

```js
for (i = 0; i < length; i++) {
    try { await listeners[i].apply(this, args); }
    catch (err) { console.error(err); }
}
```

So an `async` listener holds up whatever emitted the event. Two places where
that matters:

- `sendMessageAsUser()` does `await eventSource.emit(MESSAGE_SENT, chat_id)`
  and is itself awaited by `Generate()` **before the request goes out**. Work
  done in a `MESSAGE_SENT` listener therefore delays the reply's first token.
- `MESSAGE_RECEIVED` is emitted *before* `addOneMessage()`, so without
  streaming a listener there delays the reply being rendered at all.

An extension that needs to do slow work on a message should mark and queue it
synchronously and return, rather than awaiting the work in the listener.

The per-listener try/catch is also why a listener that throws is invisible in
the UI: every other listener still runs, and the only trace is a console error.

`GENERATION_ENDED` is not a reliable counterpart to `GENERATION_STARTED`: it is
emitted from `hideStopButton()` behind a NOOP guard (`if display !== 'none'`)
and without `await`, so a generation that never showed a stop button never
fires it. Anything gated on it needs a second release path.

## Slash commands / swipe from JS

`context.executeSlashCommandsWithOptions(command)` runs raw stscript
(`/inject`, `/continue`, `/trigger`, `/flushinject`, etc.) from extension
code. `context.swipe.right()` (SillyTavern ≥ 1.13.0) triggers a new swipe
generation programmatically.

Three things about that pair are easy to get wrong:

- **`swipe.right()` only generates from the newest swipe.** From any earlier
  one it steps forward through the swipes that already exist, and generates
  nothing. Anything that means "generate another swipe" has to move
  `swipe_id` to `swipes.length - 1` first — setting `mes` from
  `swipes[target]`, `extra` from `swipe_info[target].extra`, re-rendering
  `.mes_text` via `context.messageFormatting()` and the `.swipes-counter`
  elements, then emitting `MESSAGE_SWIPED`. `swipes` and `swipe_info` are two
  parallel arrays and both have to stay aligned.
- **A user message is not swipeable or continuable.** Neither call validates
  this; check `chat[chat.length - 1].is_user` before either.
- **`{{input}}` beats interpolating the input bar's text.** The macro is
  substituted after the command has been parsed, so `/send {{input}}` survives
  a message containing `|`, where `/send ${textarea.value}` would truncate at
  the pipe and run the remainder as a command. Where a macro won't do, strip
  `|` and newlines from the value first (`src/stscript.js`).

`/continue` writes into the last message in place rather than appending a new
one, so anything wanting to undo it has to read `mes` *before* the call. The
new text is also written to `swipes[swipe_id]`, so restoring only `mes` brings
the continuation back on the next re-render.

## `/inject` position mapping (verified against `script.js`/`openai.js`)

`/inject position=<before|after|chat|none>` maps to
`extension_prompt_types.{BEFORE_PROMPT, IN_PROMPT, IN_CHAT, NONE}`. These are
three genuinely different insertion points, not interchangeable:

- `before` (`BEFORE_PROMPT`) / `after` (`IN_PROMPT`) — read via
  `getExtensionPrompt(type)` (no depth) and fed into the Context Template
  (the Handlebars-ish story-string template under
  User Settings → Context Template) as `anchorBefore` / `anchorAfter`. This
  is the same slot Author's Note "before/after story string" uses. For Chat
  Completion APIs the equivalent is the prompt-manager collection, inserted
  at `'start'`/`'end'` (`openai.js`'s `getPromptPosition`).
- `chat` (`IN_CHAT`, requires `depth=`) — spliced in as a synthetic message
  at the given depth into the actual chat-history message array
  (`doChatInject` for Text Completion, `populationInjectionPrompts` for Chat
  Completion). This is a **separate mechanism** from the Context Template
  above and does not populate any of its fields.

Two consequences of how `getExtensionPrompt` assembles several injects at the
same position:

```js
let values = prompts.map(x => x.value.trim()).join(separator);
```

- Values are joined with a **single** newline (`separator` is `'\n'` for the
  story-string anchors), and **each value is trimmed** first. So a blank line
  between two injects cannot be produced from inside either one - a trailing or
  leading newline is removed before the join. An extension that wants its
  sections separated by a blank line has to put them in one inject.
- The order is `Object.keys(extension_prompts).sort()`, i.e. alphabetical by
  inject id. Two injects whose relative order matters must not rely on it.

`processChatSlashCommands()` rehydrates every entry of
`chat_metadata.script_injects` when a chat loads. `ephemeral=true` deletes that
entry on `GENERATION_ENDED`/`GENERATION_STOPPED`, but a generation that never
ended leaves the entry in the chat file, and it comes back on the next load.
Renaming or retiring an inject id therefore needs a one-time flush of the old
id, or its stale text keeps being injected.

`wiBefore`/`wiAfter` in the Context Template are populated only from
activated World Info/lorebook entries (`getWorldInfoPrompt`) — there is no
`/inject` position that lands there; an extension would have to manage an
actual (e.g. constant) lorebook entry to put content in that specific slot.

Symptom this explains: content injected with `position=chat` can be
completely absent from what a prompt inspector shows for the Context
Template/system-prompt block, even though the `/inject` call itself
succeeded - it went into the chat-history splice point instead, which is
outside that template entirely.

## `/inject role=` and `depth=0` (verified against SillyTavern 1.18 source)

`injectCallback` (`public/scripts/slash-commands.js`) accepts
`role=system|user|assistant` and defaults to SYSTEM. What each becomes:

- Chat Completion (`populationInjectionPrompts`, `public/scripts/openai.js`):
  a real `{ role, content }` message, spliced into the history array. The
  function reverses the array, splices at index = depth, and reverses back, so
  `depth=0` is the **last** message of the final array.
- Text Completion (`doChatInject`, `public/script.js`): a synthetic chat
  message. `role=system` gives it `extra.type = 'narrator'` and an empty name,
  which is what makes instruct mode wrap it in the system sequence; `user`/
  `assistant` borrow `name1`/`name2`.

Two consequences worth knowing:

- The default Chat Completion preset orders `… dialogueExamples, chatHistory,
  jailbreak`, so a `depth=0` inject sits after the last message but *before*
  the post-history instructions.
- On **continue**, `doChatInject` silently bumps `depth=0` to 1 so the inject
  cannot cut into the message being continued. A depth-0 inject is therefore
  one message further back on a continue than on a normal turn.

This is the position to use for anything that changes every turn: the Context
Template (`position=before`/`after`) sits in front of the whole chat, so a
value that differs per generation invalidates the prompt cache from the story
string onwards. At `depth=0` only the new content is new.

`getExtensionPrompt` runs `substituteParams` over the assembled value, so
macros like `{{char}}` in an inject survive to prompt-build time no matter
whether stscript already substituted them when the command ran.

## What `is_system` actually means on a chat message

`is_system: true` is not one thing, and it is the only flag `/hide` sets.
Verified in `scripts/chats.js` and `scripts/slash-commands.js`:

| Message | `is_system` | `extra.type` | Story text? |
|---|---|---|---|
| Normal user/character message | `false` | unset | yes |
| Hidden via `/hide` | `true` | unchanged (unset) | yes — hiding only removes it from the *context*, `hideChatMessageRange` flips the flag and nothing else |
| `/sys` narration | `false` | `narrator` | yes |
| `/sys` that only sets a bias | `true` | `narrator` | no |
| `/comment` note | `true` | `comment` | no (OOC) |
| ST's own UI messages (welcome, help, hotkeys, …) | `true` | the type name | no |

So `!message.is_system` alone reads as "is in the context right now", not as
"is story text". To tell ST's own messages from story text, use `extra.type`:
`getSystemMessageByType` stamps it on every system message, `sendCommentMessage`
sets `comment`, and a normal message never carries it — with `narrator` as the
one type that *is* story text.

## Hiding messages from JS (`/hide`, `/unhide`)

`hideChatMessageRange(start, end, unhide, nameFilter)` (`scripts/chats.js`) is
what both commands call, and it is not on `getContext()` — the reachable entry
point is the slash command:
`context.executeSlashCommandsWithOptions('/hide 4-11')`. Verified against
`slash-commands.js`/`chats.js`/`utils.js`:

- The unnamed argument is an index or an **inclusive** range parsed by
  `stringToRange`, i.e. `4-11`, or `4` for a single message. Out-of-bounds or
  reversed ranges parse to `null` and the command no-ops with a console
  warning. Omitting the argument entirely targets the **last** message, which
  is rarely what a script wants.
- Per message it sets `is_system`, mirrors it onto the `.mes[mesid]` block's
  `is_system` attribute, then calls `refreshSwipeButtons()` and
  `saveChatConditional()` once for the whole range. So one call per contiguous
  range, not per message — each call writes the chat file.
- `/unhide` over a range is **not** the inverse of "was hidden by `/hide`": it
  clears `is_system` on everything in the range, so a `/comment` note or one of
  ST's own UI messages caught in the range becomes a normal, injected message.
  Anything that unhides a range has to build it from story messages only
  (`extra.type` unset, or `narrator`).

## Debugging tip: clone, don't fetch

Web-fetching SillyTavern's large core files (`index.html`, `script.js`,
`openai.js`) for a specific detail is unreliable — the content gets
summarized/truncated before reaching the relevant section, especially past
a few thousand lines. `git clone --depth 1 <repo>` locally and `Grep`/`Read`
directly is far more reliable for verifying exact markup or behavior than
repeated lossy fetches of the same file.
