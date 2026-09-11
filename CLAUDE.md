# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repository.

## Project

`st-psychograph` is a SillyTavern extension implementing a layered memory
system for roleplay chats:

1. **State** — a mutable snapshot (clothing, body, scene), overwritten on
   every message. The only layer that exists today: 14 slots in 3 areas,
   extracted by a gate -> per-area diff -> per-slot update pipeline and
   injected as `## Current state information`.
2. **Dispositions / Episodes** — what a character has come to believe, and the
   events behind it. Designed, not built.
3. **Lore/Graph** — a knowledge graph of relationships between characters,
   places, and events, backed by [Cognee](https://www.cognee.ai/).

Two documents carry the rationale, and both are the source of truth for
*why* — read them before making design decisions on any layer:

- [`docs/memory-system.md`](docs/memory-system.md) — the layers as built,
  including what belongs in State and what deliberately does not.
- [`docs/memory-architecture.md`](docs/memory-architecture.md) — the target
  picture: the four layers, why retrieval runs through a disposition index
  rather than over raw chat, and why significance can only accumulate rather
  than be decided at write time.

## Cognee API reference

The raw OpenAPI spec for the Cognee backend is committed at
[`docs/reference/cognee-openapi.json`](docs/reference/cognee-openapi.json)
(104 endpoints, unmodified). Only a small subset matters for the Lore/Graph
layer — look them up directly in the spec rather than re-deriving them:

- `POST /api/v1/remember` — combines add+cognify; with `session_id` set,
  ingestion goes through the session cache and is bridged into the permanent
  graph in the background. This maps directly onto the two storage levels
  described in `docs/memory-system.md` §3 (session memory vs. permanent
  knowledge graph).
- `POST /api/v1/remember/entry` — typed entries (QA, trace, feedback,
  skill-run) stored in the session cache.
- `POST /api/v1/recall` / `GET /api/v1/recall` — memory-oriented search,
  supports `scope` (graph/session/trace/…), `session_id`, `search_type`.
- `POST /api/v1/search` — generic graph search (e.g. `GRAPH_COMPLETION`,
  `HYBRID_COMPLETION` search types).
- `POST /api/v1/memify` — enrichment pipeline; the `detect_entity_duplicates`
  and `merge_entity_duplicates` tasks are the direct mitigation for the
  phantom-entity risk described in `docs/memory-system.md` §3 (pronouns/
  nicknames not merged onto known persons).
- `POST /api/v1/add`, `POST /api/v1/cognify` — individual ingestion/
  processing steps, for when `/remember` doesn't give enough control.
- `POST /api/v1/forget`, `PATCH /api/v1/update`, `/api/v1/datasets` —
  dataset cleanup/management (e.g. one dataset per chat or character).
- Auth: `/api/v1/auth/api-keys` — API-key auth, the natural fit for a
  self-hosted extension talking to a self-hosted Cognee instance.

To look up a specific endpoint's full request/response schema:

```bash
jq '.paths["/api/v1/recall"]' docs/reference/cognee-openapi.json
```

## Build narrow

This project should stay as small a dependency surface as reasonably
possible:

- Prefer vanilla JS and the browser's `fetch` over adding libraries or an
  HTTP client dependency.
- Avoid bundlers/build tooling unless SillyTavern's extension loading model
  actually requires one — SillyTavern loads extensions as plain scripts, so
  default to writing code that runs unmodified.
- Before adding any dependency, check whether the same result is reachable
  with what SillyTavern's extension API and the browser already provide.

This applies to every layer, not just initial scaffolding — resist adding a
state-management library, a graph-viz library, etc. unless the task genuinely
can't be done without one.

## Code comments

Default to no comments. Only add one when nothing else (types, tests, naming,
the diff/PR description) already explains why the code does something
non-obvious — never to restate what the code does. Max 1-2 sentences, stating
only the why (a hidden constraint, a workaround, a non-obvious side effect),
never a walkthrough of the code itself.

## Extraction prompt wording

The wording of LLM extraction prompts (everything under `src/prompts/`, the
driver and continuation text in `src/layers/motivation/drivers.js`, and
any future prompt built the same way) is tuned empirically against the user's own backend/model, not
derived from first principles. Small local models are highly sensitive to
phrasing in ways that aren't obvious from reading the prompt — an "improvement"
that looks reasonable (adding example items per category, a JSON few-shot
example, etc.) can silently make results worse by causing the model to
overfit to the examples given instead of generalizing.

Do not change the wording of an existing extraction prompt on your own
initiative — not even a rephrase that looks harmless. Always show the
proposed wording change and get explicit sign-off before editing, and let the
user test it against their own model before treating it as done. Structural
changes around a prompt (which variables it's built from, when it's called,
its token budget) are fine to make normally; the prompt text itself is not.

## Branch workflow

All work happens on feature branches. Never commit directly to `main`.

## Working tickets

Before implementing an issue, label it **`claude-work`** — the agent applies
the label itself, and only then starts. The label is how the repo owner sees
at a glance which tickets are being worked on, so it goes on *first*, not
alongside the first commit or after the fact.

- One labelled issue at a time per piece of work. The label marks what is
  actually in progress; labelling a batch up front defeats its purpose.
- The label scopes the work to that issue. A neighbouring issue that turns
  out to need a change is reported, not fixed in passing — and not labelled
  either.
- It is a work marker, not a permission slip. It records what was asked for;
  it never substitutes for asking. An issue nobody asked to have implemented
  does not get labelled and worked on unprompted.
- Remove the label once the work is done (merged, or dropped), so the labelled
  set stays a picture of the present.
- This covers *implementation*. Reading the repo and the issues to answer a
  question, and commenting on issues, need no label.

A PR that implements an issue closes it. Put a closing keyword and the issue
number in the PR **description** — `Closes #12` — so merging the PR closes the
ticket by itself. GitHub only acts on the keyword in the description (and in
commit messages on the default branch), not in a PR title or a comment, and
only for the same repository unless the reference is written `owner/repo#12`.

- One line, on its own, near the top or bottom of the description. Referencing
  the issue anywhere else in the text is fine, but does not close anything.
- A PR that touches several issues repeats the keyword per issue —
  `Closes #12, closes #14`. A bare `#14` in the same sentence does not count.
- For work that only advances a ticket rather than finishing it, reference it
  *without* a keyword (`Part of #12`), so the merge leaves it open.

## Language

Talk to the repo owner in **German**. Everything that lands in the repo or on
GitHub is written in **English** — code, comments, README, this file, commit
messages, branch names, issues, PRs and issue/PR comments — regardless of the
language used in source material or in the conversation that produced it.

So a German conversation still produces English commits and English issue
comments; only the chat itself switches language.

## SillyTavern extension conventions

- A `manifest.json` at the extension root declares metadata and the entry
  script.
- `index.js` is the entry point; it registers UI via jQuery and hooks into
  SillyTavern's event system (e.g. reacting to new messages). Here it is a
  bootstrap only — the code lives under `src/` (see *Source layout*).
- Settings UI is a small HTML partial injected into SillyTavern's
  extensions settings panel, backed by a key in `extension_settings`.
- For local development, an extension is loaded from
  `public/scripts/extensions/third-party/<extension-name>/` inside a
  SillyTavern checkout (or symlinked there).

For anything beyond this basic shape (import paths, adding toolbar/menu UI,
connection-profile access, schema-enforcement caveats, chat events), see
[`docs/sillytavern-ui-notes.md`](docs/sillytavern-ui-notes.md) — verified
findings from reading SillyTavern's own source, not orientation guesses.
Update that file, don't re-derive from scratch, when something there turns
out to be version-specific or wrong.

## Source layout

`index.js` is the SillyTavern entry point and does nothing but wire the pieces
together on jQuery ready. Everything else lives under `src/`:

| Path | Holds |
|---|---|
| `src/sillytavern.js` | Every import into SillyTavern's own source, and nowhere else. The depths differ per file and an extra `../` 404s silently at load time, so they are kept in one place. |
| `src/constants.js` | Extension name/path and the `message`/`seed` extraction modes. |
| `src/settings.js` | Global `extension_settings` branch: defaults and `ensureSettings()`. |
| `src/chat-state.js` | The per-chat `chat_metadata` branch: `ensureChatState()`, the layout migrations, and who the sheet is about. |
| `src/messages.js` | What counts as a story/timeline message, and the per-message "already extracted" markers. |
| `src/undo.js` | The one-step snapshot behind "Restore previous". |
| `src/extraction-queue.js` | The FIFO lane per layer, the concurrency budget while a generation runs, and the count behind the toolbar spinner. |
| `src/llm/` | `request.js` — profile resolution, the schema-enforced request, the backfill pool. `similarity.js` — rerank/embedding calls that go straight to the user's own server. |
| `src/prompts/` | Prompt text and response schemas only, one file per layer. Nothing here reads or writes state. |
| `src/layers/state/` | `areas.js` — the 14 slots across 3 areas and their per-area config. `extraction.js` — the gate -> diff -> per-slot-update pipeline. |
| `src/layers/timeline/` | `store.js` — the timeline blob and its work queue. `extraction.js` — per-message entries and the full rebuild. |
| `src/layers/knowledge/` | `layers.js` — the three layer configurations (facts, dispositions, triggers). `store.js` — entry lists, dedup and merge. `extraction.js` — the model calls, card seeding and the rebuild. |
| `src/layers/motivation/` | `drivers.js` — the eight drivers, the five continuation rules, the standing goal block, and the inject they build. `lottery.js` — the per-turn draw, the lock, the chat's goal, and the roll recorded on each message. |
| `src/layers/cognee.js` | The Cognee client: chat-scoped datasets, ingestion, backfill, recall. |
| `src/injects.js` | Every `setExtensionPrompt` the memory layers make, and the generation hook that refreshes them. |
| `src/ui/` | `settings-panel.js`, `sheet.js`, `guided.js`, `toolbar.js`, `message-buttons.js`. |
| `src/events.js` | The SillyTavern event bindings. |

Two conventions worth keeping:

- A layer never imports another layer's internals; it goes through that layer's
  store or extraction entry point.
- Data modules calling a `render*` function from `src/ui/` is how the sheet
  stays live, and it does make those imports circular. That works because every
  such reference is a function call at runtime — never a value read while a
  module is still evaluating. Keep it that way: a `const` in one of those
  modules must not be initialised from the other side of a cycle.

## Roadmap

The implementation roadmap is tracked as GitHub issues in this repository,
not duplicated here. See the open issues for the current epics (scaffolding,
state layer, core memories layer, lore/graph layer, cross-layer
integration).
