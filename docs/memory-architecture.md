# Memory Architecture

Where each kind of knowledge lives, and why. This is the target picture;
[`memory-system.md`](memory-system.md) documents the layers as built.

Only the State layer exists today. The rest is design, recorded so the next
decision can be checked against it rather than re-derived.

## The problem this solves

Roleplay stops being immersive at message 5000 for two reasons: the character
forgets what happened, and the character stops wanting anything. Chat
summarisation addresses neither — it compresses uniformly, which loses exactly
the specific details that make a callback land ("the thing you said on our
first date").

The model to copy is human memory, not a transcript. Asked to describe myself
right now I know: I am frustrated because a plan is not working; I am wearing a
black polo shirt; I want to build a system that stays immersive at 5000
messages; I have experience with three tools; I distrust one of them because of
something that happened. Five lines — and every detail behind them is
retrievable but not currently loaded.

## Four layers

Ordered by how often they change.

| Layer | Update rule | Always in prompt | Example |
|---|---|---|---|
| **Situation** | overwrite, every message | yes | black polo shirt |
| **Drives** | slow, few | yes | wants to build the system |
| **Dispositions** | slow growth, capped | yes | distrusts vector search |
| **Episodes** | append-only, unbounded | no — reached through the layers above | *why* they distrust it |

Emotion is not a layer. It is what you read off Drives against Situation: a
blocked plan produces frustration without anyone labelling it. Extracting
"is she sad?" is subjective and a small model will be inconsistent at it;
extracting "did her plan just fail?" is factual and it will not. Objective
input, emergent output.

Drives currently live in a separate plugin (long- and short-term goals), so
this repository covers Situation, Dispositions and Episodes.

## Semantic and episodic

The split between the last two layers is the one from human memory, and it
decides what goes where:

- **Dispositions are semantic.** "He was in a war and it left a mark." Changes
  how the character behaves at all times. Small, always present.
- **Episodes are episodic.** "In week three a shell landed next to him and
  Marek died." Matters when the subject comes up. Unbounded, retrieved.

The existing `stateOfMind` slots — beliefs, trauma, conditioning, triggers,
alters, influences — are all dispositional. That layer was the right idea in
the wrong place: it sat in an overwrite snapshot with append semantics bolted
on, had no episodes behind it to point at, and no rule to stop it growing.

## Why not plain RAG over the chat

SillyTavern's vector search injects a blue police car when the sky is blue.
That is not a flaw in retrieval, it is retrieval over the wrong representation:
embeddings of raw chat text are dominated by concrete nouns and adjectives, and
the meaning is the quietest signal in the chunk.

Three things avoid it here:

1. **Never embed raw text.** Embed the distillation — "he believes he is
   worthless", "fireworks bring the war back". The extraction step is the noise
   filter; the polo shirt and the blue sky are gone before anything is embedded.
2. **Search a small curated set.** ~25 dispositions and ~150 episode summaries,
   not 2000 chunks. At that size a cross-encoder can score every candidate.
3. **Query the index, not the scene.** The search space contains no police cars,
   so one cannot be retrieved.

## Retrieval

Similarity between the current message and past events is a bad proxy for
relevance: at a fireworks display the war trauma matters, and "fireworks" is not
close to "shelling" in embedding space. So retrieval runs through the
disposition index rather than over the episode log:

1. The index is small enough to inject whole, and is itself useful — with
   nothing else retrieved the character still behaves like someone with a war
   trauma. Graceful degradation.
2. A cheap librarian call gets the index plus the last few messages and returns
   which entries matter now. A 4B can reason "they are at a fireworks display,
   the war entry applies" where cosine cannot.
3. The chosen entries expand into their episodes.

Not a tool call from the roleplay model: a human does not decide to look
something up, the association fires unbidden, and a 4B mid-generation will not
do it reliably anyway.

`triggers` is the special case — a disposition with an authored cue attached, so
it can be matched directly against the incoming message with no librarian.

Budget stays constant regardless of chat length: ~100 tokens of situation, ~400
of index, ~250 of expanded detail.

## Significance is retroactive

At the time of the first date nobody knows it was the first date. Asking a model
"is this a key moment?" asks it to predict the story's future, which is why the
question has no good answer — it is ill-posed, not badly prompted.

So nothing is filtered at write time. Everything is indexed, and significance
accumulates:

- **Novelty** — distance from the centroid of recent messages. Arithmetic.
- **Firsts** — first appearance of a person, place, or kind of event. A lookup,
  not a judgement, and a strong proxy: first meeting, first kiss, first fight,
  first betrayal.
- **Arousal** — 1–5, one cheap call. The one question about the text in front of
  the model rather than about the future.
- **Rehearsal** — retrieved and used, score up. This is what separates a memory
  from an archive, and no plugin does it.
- **Decay** — everything else sinks. Not deleted, just later.

## Episodes, not messages

The unit is the scene. The `situational` slots already detect scene boundaries —
when location, time or cast change, the episode ends — so segmentation is
mostly a by-product of the State layer rather than a new model call.

2000 messages become perhaps 100–150 episodes, each with a title, a summary, a
message range and a significance score. That is the granularity where
everything works: the ordered list *is* the timeline, retrieval runs over
distilled summaries instead of raw text, and 150 candidates can be reranked
exhaustively.

Raw messages are all kept and reachable through their episode's range — recall
the episode, then the detail, which is the two-stage shape of the human case.
Reference them by a stable id in `message.extra`, not by array index, which
shifts on deletion.

For the prompt the timeline is zoomed rather than truncated: recent episodes
individually, older ones merged into arcs, oldest into eras. Resolution falls
off with distance, which is also how one remembers a long relationship.

## Compaction

The twentieth war memory does not earn a new index entry, it merges into "the
war". Only the sharp ones stay separately addressable.

Mechanically: embed each new entry, score it against the existing index. Above
threshold it attaches to that entry; below, it starts a new one. The index is
then bounded by the number of *topics* — 20–40 in a long roleplay — not by the
number of messages. That is the structural ceiling, rather than a truncation.

**The log is the truth, the index is derived.** A bad index is a recompute, not
data loss. This is the property the current `"; "`-joined slots lack, where the
compaction is the only copy and every model error is permanent.

## Models

Three are available locally: `Qwen3-4B-Instruct-2507`, `Qwen3-Embedding-0.6B`,
`Qwen3-Reranker-0.6B`. The latter two are unused today.

- **Reranker** — a cross-encoder scoring (instruction, query, document) is
  exactly the gate question, but as a *score* rather than an LLM boolean. Over
  a small candidate set it turns trigger quality into a threshold that can be
  calibrated against real transcripts, instead of a prompt-wording argument.
  Blocker: no OpenAI-standard rerank endpoint; check whether the serving stack
  exposes one before designing around it.
- **Embedding** — instruction-aware, so it can be steered toward "state change"
  rather than topical similarity. Needed for compaction and for cue matching.
- Because retrieval goes through the index, only ~150 vectors are ever searched.
  Brute-force cosine in JS is sub-millisecond at that size, so no vector
  database, no IndexedDB, no dependency — which is also what
  [`CLAUDE.md`](../CLAUDE.md) asks for.

## Open risks

- **The merge threshold** is the parameter the system stands or falls on. Too
  loose and everything becomes "the war"; too strict and the index grows anyway.
- **Rewriting an index entry** is the only place a model edits something that
  already exists — the last remaining source of drift. Regenerability from the
  log is what makes it repairable rather than permanent.
- **What a character does not know** has to be recorded per episode from the
  start. It cannot be reconstructed afterwards, and without it a character at
  message 5000 knows things they never witnessed.
