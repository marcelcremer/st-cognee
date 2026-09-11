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

**Clothes: observation instead of a boolean diff.** The diff already worked out
which item belongs in which slot — its reasoning would read "footwear (foam
slides), accessories (choker)" — and the pipeline kept one boolean of it. The
per-slot update then had to find the item again, without the slot definitions
the diff carries in its schema and without the per-slot walk its reasoning
description forces; on an empty sheet it answered four slots with the whole
outfit. Clothes therefore asks for a value per slot, and the decision moves into
code:

- `"not mentioned"` leaves the slot alone.
- An observed value that meets an *empty* slot is written straight in. There is
  nothing to merge, so there is nothing to ask.
- An observed value equal to what is there does nothing.
- Only a slot that already holds something different reaches stage 3, which is
  the one question that needs a model: does the new item replace what is there,
  or layer over it?

An opening scene on an empty sheet costs two calls instead of nine, and the
seven values come from the call that already had them right.

Two shapes were tried and rejected against the 4B this is tuned for. Asking what
*changed* returns nothing on an opening scene, because such a scene describes an
outfit without changing it. Putting the sheet into that prompt made the model
claim the message's items were already on it. The observation prompt therefore
asks what the message *says*, and never sees the sheet — which is also why it
cannot invent its contents.

**Merge.** Stage 3 sees the current value, so it can produce the new value
directly. An earlier design had the extraction run observation-only, without the
previous state, which is why it needed sentinels for "no info" and an explicit
`peopleLeaving` delta to remove someone from the scene. Neither is necessary
here: the model has both sides in front of it and writes the resulting list,
removals included.

**Seeding.** The sheet starts from the character card, not from zero. On the
first extraction run of a chat, every active area is seeded from the card —
description or persona for the character areas, scenario for Scene — before the
message itself is processed, and a `seeded` flag on the chat records that it
happened. The flag rather than a message id, so switching the extension on
mid-chat still seeds; a chat that already carries extracted state counts as
seeded, so introducing the flag does not overwrite what such a chat established
on its own. The toolbar's *Init* entries stay, as a manual re-seed.

`bodyChanges` is the one slot excluded from seeding: it stores a delta against
the card, so seeding it from the card would fill it with exactly what it is
meant to be different from.

**Seed prompts.** Reading a static profile is a different job from finding a
delta in a story beat, so a seed run renders its own variant of the same
document. It says the text below is a profile (or a scenario) rather than a
message, its rules ask what the profile *describes* instead of what the message
*changes*, and it drops the current-value section — establishing the starting
value is the whole point, so the value it replaces has no business being in the
prompt.

**Empty values.** `""` everywhere, for every reason — never established, user
cleared it, nothing there. Empty slots are not injected at all. The single
exception is Clothes, where `"none"` is a stored, injected value: an empty
clothing slot is the information, not its absence.

**Injection.** The snapshot is injected as `## Current state information`, via
the same ephemeral `position=after` inject the Cognee recall uses. Character
areas are labelled with the tracked character's name, since "top: blue blouse"
alone does not say whose.

**Prompt shape.** All three stages render the same markdown document: a task
description naming whose sheet is being filled in, the assignment (one slot, one
group of slots, or the list of areas), the rules, the hints, the output format —
and then the message last, after a `---`, with its speaker on the line above it.
Naming the sheet's owner is what lets extraction run on every message: the
earlier design restricted it by who wrote the message, which is the wrong axis,
since information about Jacob is information about Jacob no matter who typed it.
The gate is the exception and names no owner — it decides only whether a turn
touches an area at all, never what the value would be.

**Which message, and how often.** Extraction runs on the *predecessor* of the
newest message, exactly once. Only the newest message can be swiped, so the
predecessor is settled: a swipe re-fires the message event, the predecessor is
already marked as extracted, and nothing runs a second time on top of state the
first run already moved. The marker is a flag in `message.extra` rather than an
in-memory set, so it survives a reload. Deleting or editing the newest message
needs no handling for the same reason — it was never extracted.

The cost is that the sheet lags one message behind: while message N is being
generated, the snapshot covers through N-2. N-1 is verbatim in the context
window right above the inject, though, so the model reads it there — the same
reasoning that kept `mood` out of this layer.

**Open issues:**
- Deleting or editing a message from the *middle* of a chat leaves what it
  contributed in the sheet. That needs a rollback stack, but it is the rare
  case; the common ones above are covered without one.
- The toolbar's manual re-run still targets the newest message and does not mark
  it, so a re-run followed by the automatic pass applies that message twice.
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
