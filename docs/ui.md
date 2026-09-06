# Extension UI

This documents what's actually implemented in `index.js`/`settings.html` —
the settings panel layout and the chat toolbar additions. For the *why*
behind the three memory layers, see [`memory-system.md`](memory-system.md);
for the rule on changing extraction prompt wording, see
[`../CLAUDE.md`](../CLAUDE.md).

## Settings panel

Extensions → Psychograph:

- **Enable Psychograph** — top-level checkbox, gates the automatic
  per-message extraction hook (manual actions like the toolbar buttons
  below work regardless of this setting).
- **Connection Profile** — a SillyTavern Connection Manager profile,
  read directly from `extension_settings.connectionManager.profiles`.
  This is the connection used for Psychograph's own extraction calls; it's
  independent of whatever connection is active for the roleplay itself, so
  extraction can run on a different (typically smaller/faster/local) model.
  "SillyTavern default" (empty selection) has no resolvable profile ID, so
  extraction is skipped with a console warning until a real profile is
  picked.
- **State**
  - **General** — "Applies to" (Character/User): whose state is tracked,
    and which chat event triggers extraction (see below). No prompt
    override here — it's a routing setting, not an extraction category.
  - **Clothes** — "Default prompt" checkbox (unchecked reveals a custom
    prompt textarea overriding the diff prompt; use `{{message}}` as the
    placeholder) plus 8 editable slot fields (top, bottom, underwear,
    legwear, footwear, accessories, hair, makeup) showing the current
    tracked state. Slots are hand-editable — manual corrections persist
    until the next extraction run overwrites them.
  - **Physical State / State of Mind / Situational / Expectations** —
    same "Default prompt" control, no extraction logic behind them yet
    (placeholders for future areas).
- **Core Memories** — placeholder, not implemented.
- **Lore / Graph** — placeholder; nested **Cognee Connection** (Base URL,
  API Key) for the future Lore/Graph layer.

## Chat toolbar

A `psychograph-button-container` div is inserted as a sibling right after
SillyTavern's `#nonQRFormItems` (the message-input row) — the same
insertion point/pattern the GuidedGenerations extension uses for its own
button row. Third-party extensions don't get a pre-declared container in
SillyTavern's own markup (unlike bundled extensions such as Caption or
Translate), so this is the standard way to add a persistent toolbar row.

Left side:

- **Psychograph** (brain icon) — opens a small submenu anchored above the
  button (`position: absolute` + `getBoundingClientRect()` +
  `window.scrollX/Y`, toggled via a `.shown` class rather than the
  `hidden` attribute — SillyTavern's own CSS for `.list-group` outranks
  the browser's default `[hidden]` rule, so `hidden` alone doesn't
  actually hide anything reusing that class). Submenu entries:
  - **Clothes** — re-runs the clothing diff+update extraction on
    whichever message is actually last in the chat, regardless of sender
    or the State → "Applies to" setting (that setting only gates the
    *automatic* hook, not this manual one). Useful for retesting a prompt
    change without sending a new message.
  - **Init Clothes** — one-time seed of the clothing slots from the
    character description (target = Character) or persona description
    (target = User), via `getContext().getCharacterCardFields()`. Feeds
    that text through the same diff+update pipeline as a chat message —
    no separate prompt needed.

Right side (`psychograph-guided-buttons`), in this order:

- **Guided Swipe**, **Guided Message**, **Guided Continue** — a standalone
  reimplementation of the GuidedGenerations extension's generic guide
  mechanic, independent of Psychograph's own state tracking (works without
  that extension installed): type a private instruction into the message
  box, click one of these, and it's used for exactly one generation
  without ever becoming a visible chat message (input is restored
  afterward). Swipe/Message inject the text as an ephemeral system-role
  prompt (`/inject ... ephemeral=true`, flushed after generation); Continue
  passes it directly as `/continue`'s parameter instead, SillyTavern's own
  mechanism for steering a continuation.
  Deliberately narrower than the reference implementation: no group-chat
  member picker, no undo/revert tracking, no per-action prompt-template/
  depth/role settings.

## Automatic clothing extraction

Triggered per chat message based on State → General → "Applies to":

- **Character** — on `MESSAGE_RECEIVED` and `MESSAGE_SWIPED`.
- **User** — on `MESSAGE_SENT`.

Two-stage per message (see `docs/memory-system.md` §1 for the general
State-layer rationale): a diff call classifies which of the 8 slots the
message touches (booleans + a debug-only `reasoning` field, deliberately
placed *before* the booleans in the schema so a model doing real
grammar-constrained decoding has to reason before committing), then one
update call per flagged slot rewrites that slot's full state from its
current value + the message. Untouched slots are left alone — no second
LLM call, no diff/merge judgment outside the model's own two calls.

Schema enforcement (`response_format`/`json_schema`) is attempted but not
guaranteed end-to-end for every backend, so both prompts also explicitly
ask for a bare JSON object, and parsing tolerates markdown code fences or
stray text around it. A response that still can't be parsed as JSON is
logged and skipped — no retry loop.
