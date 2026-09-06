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
- [`docs/reference/cognee-openapi.json`](docs/reference/cognee-openapi.json)
  — raw OpenAPI spec for the Cognee backend used by the Lore/Graph layer.
- [`CLAUDE.md`](CLAUDE.md) — guidance for agents/contributors working in this
  repo (relevant Cognee endpoints, dependency policy, conventions).

## Development

This project aims to stay as dependency-light as possible — see the "Build
narrow" section in [`CLAUDE.md`](CLAUDE.md). All work happens on feature
branches.
