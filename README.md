# st-cognee

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that
gives roleplay chats a three-tier memory system:

1. **State** — a live snapshot of the scene (location, present people,
   emotion), overwritten on every message.
2. **Core Memories** — an append-only timeline of significant moments, never
   edited or deleted.
3. **Lore/Graph** — a knowledge graph of relationships between characters,
   places, and events, backed by [Cognee](https://www.cognee.ai/).

Each layer exists because it solves a structurally different retrieval
problem — a single mutable snapshot, a chronological list, and a traversable
graph don't substitute for each other. See
[`docs/memory-system.md`](docs/memory-system.md) for the full design
rationale, including known open issues per layer.

## Status

Early development. The extension scaffolding, and all three memory layers,
are still being built — see the [open issues](../../issues) for the current
roadmap (one epic per layer, plus scaffolding and cross-layer integration).
Nothing here is installable yet.

## Documentation

- [`docs/memory-system.md`](docs/memory-system.md) — architecture and design
  rationale for the three memory layers.
- [`docs/sillytavern-ui-notes.md`](docs/sillytavern-ui-notes.md) — general
  SillyTavern UI/DOM findings from building this extension's toolbar/menu
  (import paths, wand menu vs. toolbar row, the `hidden`-attribute pitfall,
  connection-profile/schema-enforcement caveats). Not Psychograph-specific
  — check before building UI for any future layer.
- [`docs/reference/cognee-openapi.json`](docs/reference/cognee-openapi.json)
  — raw OpenAPI spec for the Cognee backend used by the Lore/Graph layer.
- [`CLAUDE.md`](CLAUDE.md) — guidance for agents/contributors working in this
  repo (relevant Cognee endpoints, dependency policy, conventions).

## Development

This project aims to stay as dependency-light as possible — see the "Build
narrow" section in [`CLAUDE.md`](CLAUDE.md). All work happens on feature
branches.

Scaffolding is being developed and verified against SillyTavern `1.18.0`.

### Installing the extension locally

The extension root (`manifest.json`, `index.js`, `settings.html`, `style.css`)
lives at the repo root, so it can be loaded the same way as any other
third-party SillyTavern extension:

- **Via SillyTavern's UI (recommended):** Extensions panel → Install
  extension → paste this repository's git URL. SillyTavern clones it
  directly into `public/scripts/extensions/third-party/`.
- **Manual/local dev:** clone or symlink this repo into
  `public/scripts/extensions/third-party/st-psychograph/` inside a
  SillyTavern checkout, then reload SillyTavern.

The extension currently shows as **Psychograph** in the Extensions panel;
the settings panel only exposes placeholder sections — no memory logic is
wired up yet (see [issue #1](https://github.com/marcelcremer/st-cognee/issues/1)).
