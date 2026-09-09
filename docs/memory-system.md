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

**Goal:** Current snapshot of what is true right now — always the latest truth,
no history.

**What belongs here.** The criterion is not "does it change" but:

> Inject only what the roleplay model cannot correctly infer from the
> context it can already see.

Clothing qualifies: the blouse was mentioned 300 messages ago and has fallen
out of the window. A mood does not: it is derivable from the last three
messages, and as an injected *fact* it stops informing and starts overriding —
a character the prompt asserts is angry cannot be softened by a pampering
attempt, which breaks the scene rather than grounding it. State that the model
would have got right on its own is not neutral, it is harmful.

**Layout (14 slots in 3 areas).** Clothes stays fine-grained because layering
is what the model loses first — collapsing "blue blouse, grey blazer" into one
field loses that the blouse is underneath.

| Area | Slots |
|---|---|
| Clothes | top, bottom, underwear, legwear, footwear, accessories, hair, makeup |
| Body | condition, constraint, bodyChanges |
| Scene | location, presentPeople, timeOfDay |

- `condition` is the *temporary* bodily state; anything lasting goes to
  `bodyChanges`. A fresh bruise is a condition, the scar it leaves is a change.
- `constraint` is what limits the ability to act — rope, confinement, a
  watcher, an obligation. Not the body itself, which `condition` holds.
- `bodyChanges` stores a **delta against the character card**, not an absolute.
  The card stays the only source for the baseline, so the two cannot drift
  apart, and the slot is empty for as long as the character still matches their
  description.
- `location` carries both the place and how exposed it is, because a character's
  sense of safety drives their behaviour and is inseparable from where they are.

**Extraction: three stages, coarse to fine.** Not because the stages carry
different information — they overlap — but because they carry different
*difficulty*. "Is this message about clothing?" is a question a 4B answers
reliably; "which of these fourteen heterogeneous slots changed?" is not.
Narrowing in steps is what makes a small model dependable, and the cost of the
extra stage is one call that can suppress three.

1. **Area gate** — one call, one boolean per active area.
2. **Area diff** — one call per gated area, one boolean per slot.
3. **Slot update** — one call per triggered slot, given the current value and
   the message.

A failed gate extracts nothing rather than everything: a broken gate should not
produce the most expensive and least informed run of the pipeline.

**Merge.** Stage 3 sees the current value, so it can produce the new value
directly. An earlier design had the extraction run observation-only, without the
previous state, which is why it needed sentinels for "no info" and an explicit
`peopleLeaving` delta to remove someone from the scene. Neither is necessary
here: the model has both sides in front of it and writes the resulting list,
removals included.

**Empty values.** `""` everywhere, for every reason — never established, user
cleared it, nothing there. Empty slots are not injected at all. The single
exception is Clothes, where `"none"` is a stored, injected value: an empty
clothing slot is the information, not its absence.

**Injection.** The snapshot is injected as `## Current state information`, via
the same ephemeral `position=after` inject the Cognee recall uses. Character
areas are labelled with the tracked character's name, since "top: blue blouse"
alone does not say whose.

**Open issues:**
- Extraction runs on the newest message, which a swipe can still change, so a
  re-generated message is extracted twice on top of already-updated state.
  Extracting the *predecessor* instead — always settled — plus a once-only
  marker per message would close this, and with it deletion and editing of the
  last message.
- No prompt names the tracked character, so with two people in a scene the
  model has to guess whose clothes it is filling in. Until it does, the trigger
  is restricted by who wrote the message, which is the wrong axis: information
  about Jacob is information about Jacob no matter who typed it.
- One global slot set, so group chats cannot be represented.

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
