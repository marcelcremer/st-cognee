# Three-Tier Memory System for SillyTavern RP

## Core Principle

Three storage types with different access patterns — not a unified solution, because they structurally solve different problems:

| Storage | Access Pattern | Update Frequency |
|---|---|---|
| State | Overwrite | every message |
| Core Memories | Append-only | only on high relevance (gate) |
| Lore/Graph | Traversal | Cognee, see below |

---

## 1. State

**Goal:** Current snapshot (location, present people, emotion, possibly clothing/physical state) — always only the latest truth, no history.

**Extraction:** One LLM call per message, a pure observation task without the previous state in context:

```
Describe the current state based on the following message.
Use the exact format. If the message contains no info for a
property, mark it as false (not: guess).
```

Example schema: `{ location, presentPeople: [], currentEmotion }`

**Merge:** Purely mechanical, no second LLM call. Any field with value `false` is ignored (= "no new info, keep the old value"), every other field overwrites the old value. No diff judgment by a model needed → eliminates the main source of drift that occurred with reproducing free text (the old Guides extension).

**Open issues:**
- Sentinel collision: `false` for "no info" vs. genuine negative booleans should be separated (`null` instead of `false` for "no info").
- Missing removal case: when a person leaves the scene, "not mentioned" isn't enough — needs an explicit delta field (e.g. `peopleLeaving: []`), otherwise people stay in the list forever.
- Where possible: use JSON schema/grammar constraints instead of a retry loop (SillyTavern's TextGen settings support `json_schema`/`grammar_string`, koboldcpp turns this into grammar-constrained sampling server-side) — eliminates malformed JSON structurally instead of just making it statistically less likely.

---

## 2. Core Memories

**Goal:** Append-only timeline of significant moments — never deleted, only added to. Should later be able to resurface associatively (e.g. via vector retrieval on the already-condensed statement, not on raw text).

**Two-pass architecture:**

1. **Gate call:** Strict prompt that forces an importance rating (scale 1–5 instead of a plain bool — allows later threshold tuning without a prompt change). Should itself already be grammar-constrained (enum/number), no free text.
2. **Extraction call:** Only when the threshold is exceeded. Output: one bullet point in natural language, appended chronologically to the list, with a timestamp/message number (even if not currently used — worth recording for later recency sorting, since it can't be reconstructed after the fact).

**No merge/diff needed**, because it's append-only — every entry is final and never touched again. Eliminates the second main source of drift entirely.

**Later extension (not part of the MVP):** When building the prompt, don't inject the whole list — instead use weighted sampling by recency × importance × relevance once the list gets large.

---

## 3. Lore/Graph — Cognee

**Purpose:** This layer covers what State and Core Memories deliberately can't — relationships between characters, places, and events, and questions that go beyond a single snapshot or a chronological list ("who knows whom about what", "how did a relationship develop"). State is a point, Core Memories are a time series — Lore is the web of connections between them.

**Why Cognee instead of building it ourselves or using Graphiti:** Cognee provides extraction, graph storage, and retrieval fully integrated (including MCP support), self-hosted, without us having to write entity resolution/dedup/traversal logic ourselves. The price for that is limited control over the internal extraction prompts — unlike the State and Core Memory layers, where we write the prompts ourselves.

**Risk to keep in mind during implementation:** Cognee's extraction quality depends heavily on the model used, and RP dialogue is unfavorable for generic extraction — lots of pronouns, nicknames/pet names (the norm for us, not the exception), and sarcasm that can be taken literally. Smaller models tend not to merge pronouns/nicknames onto the correct known person, instead creating them as standalone phantom entities — over time this would fragment the graph instead of consolidating it. This isn't a Cognee-specific problem, it affects any LLM-based extraction in this genre; but it determines how much model capability we need to budget for the extraction layer, independent of the rest of the system (State/Core Memories can run on smaller, faster models because their tasks are more narrowly scoped).

**Two storage levels within Cognee itself:**
1. **Session memory** — no LLM, no schema enforcement, raw/embedded. For the ongoing conversation without graph ambitions.
2. **Permanent knowledge graph** — LLM extraction (entity/relation), this is the actual lore layer.
