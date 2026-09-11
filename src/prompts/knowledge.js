import { getContext } from "../sillytavern.js";
import { buildPromptDocument, bulletList } from "./document.js";

// Under evaluation against the user's own model — see CLAUDE.md before
// touching any of this wording.
export function buildTriggerMapPrompt(currentMap, speaker, message) {
    const context = getContext();

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `Your job is to check a recent excerpt of the roleplay between ${context.name1} and ${context.name2} for standing trigger-response patterns worth adding to a character's trigger map, and to write them if any exist. You are NOT continuing the roleplay, judging the content, or writing dialogue.`,
        },
        {
            heading: "## The test",
            content: `Imagine you're writing a character bible for a show's writers' room — the reference sheet that lists "whenever X happens, this character reliably does Y," so future episodes stay consistent. Would this excerpt earn an entry on that sheet?

That means the excerpt must state that the pair recurs — with a word like "always", "every time" or "whenever", or as a conditioning that was deliberately established. A reaction the excerpt only shows happening once is not a trigger pattern, however strong that reaction is. A single moment of sadness is not one either. "Whenever she smells smoke, she goes quiet and won't answer" is.

The excerpt may contain zero, one, or several such patterns — check for all of them, across all characters present.

If the excerpt only shows a character reacting to something, and does not say the same reaction happens whenever that condition occurs, there is nothing to log for that character.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip any pattern that reinforces or adds detail to an existing entry above (same trigger, same character) — that pattern is already captured. Only include a pattern if the trigger, the response, or the character is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"trigger" is the condition, as concrete and specific as the excerpt actually supports (e.g. "sees the color red", not "gets upset").`,
                `"response" is what reliably happens — involuntary reactions, behavior changes, emotional shifts. Neutral, present tense, no editorializing about how significant it is.`,
                `If the excerpt states *why* the pattern exists (a trauma, an implanted memory, a past event), include it briefly in "response" only if stated — don't infer a cause that isn't in the text.`,
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "trigger": "...", "response": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], speaker, message);
}

// A profile is not a scene, so the seed gets its own wording rather than the
// message prompt with other text poured into it — the same split the State
// layer makes between its message and seed modes.
export function buildTriggerSeedPrompt(name, profile, currentMap) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "Your job is to read a character profile and write down the standing trigger-response patterns it already establishes, so they are on the character's trigger map before the roleplay starts. You are NOT continuing the roleplay, judging the content, or writing dialogue.",
        },
        {
            heading: "## The test",
            content: `Imagine you're writing a character bible for a show's writers' room — the reference sheet that lists "whenever X happens, this character reliably does Y," so every episode stays consistent. Which of those entries does this profile already give you?

That means the profile must state a condition-response pair that holds whenever the condition occurs, or a conditioning that was deliberately established. A trait is not a pattern: "she is nervous around dogs" stays out. "Whenever she hears the word 'sleep', her eyes go glassy and she follows instructions" is one. A single event from the character's past is not one either, unless the profile says it still happens.

The profile may contain zero, one, or several such patterns — check for all of them.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip any pattern that reinforces or adds detail to an existing entry above (same trigger, same character) — that pattern is already captured. Only include a pattern if the trigger, the response, or the character is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"trigger" is the condition, as concrete and specific as the profile actually supports (e.g. "hears the word 'sleep'", not "gets suggestible").`,
                `"response" is what reliably happens — involuntary reactions, behavior changes, emotional shifts. Neutral, present tense, no editorializing about how significant it is.`,
                `If the profile states *why* the pattern exists (a trauma, an implanted memory, a past event), include it briefly in "response" only if stated — don't infer a cause that isn't in the text.`,
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "trigger": "...", "response": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], `Profile of ${name}`, profile);
}

// --- Facts -------------------------------------------------------------
// PROVISIONAL WORDING, not yet tested against the user's model.

export function buildFactPrompt(currentMap, speaker, message) {
    const context = getContext();

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `Your job is to check a recent excerpt of the roleplay between ${context.name1} and ${context.name2} for facts worth keeping, and to write them down if any exist. You are NOT continuing the roleplay, judging the content, or writing dialogue.`,
        },
        {
            heading: "## The test",
            content: `A fact is something that would still be true next week no matter what happens in the scene: who someone is related to, who they work for, where they come from, what they own, what they are called.

What someone is doing, feeling, wearing or where they are standing right now is not a fact — that is the current situation and it is tracked elsewhere. Neither is something that merely happened; the event belongs elsewhere, only its lasting result is a fact. "Kim quit the clinic" is an event. "Kim no longer works at the clinic" is a fact.

The excerpt may contain zero, one, or several facts — check for all of them, about anyone mentioned.`,
        },
        {
            heading: "## Already known (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a fact down if it is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `Write it as three parts: "subject", "relation", "object" — for example subject "Jake", relation "is cousin of", object "Kim Bauer".`,
                "The subject is whoever the fact is about, in the direction the excerpt states it.",
                `Keep the relation short and lowercase, in the present tense: "works at", "is cousin of", "lives in".`,
                "Do not infer a fact that the excerpt does not state.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"subject": "...", "relation": "...", "object": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], speaker, message);
}

export function buildFactSeedPrompt(name, profile, currentMap) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "Your job is to read a character profile and write down the facts it establishes, so they are known before the roleplay starts. You are NOT continuing the roleplay, judging the content, or writing dialogue.",
        },
        {
            heading: "## The test",
            content: `A fact is something that would still be true next week no matter what happens in the story: who someone is related to, who they work for, where they come from, what they own, what they are called.

What the character is *like* is not a fact — temperament, habits, looks and skills are the profile's own job and stay there. Neither is a single event from their past; only its lasting result is a fact.

The profile may contain zero, one, or several facts — check for all of them, about anyone it mentions.`,
        },
        {
            heading: "## Already known (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a fact down if it is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `Write it as three parts: "subject", "relation", "object" — for example subject "Jake", relation "is cousin of", object "Kim Bauer".`,
                "The subject is whoever the fact is about, in the direction the profile states it.",
                `Keep the relation short and lowercase, in the present tense: "works at", "is cousin of", "lives in".`,
                "Do not infer a fact that the profile does not state.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"subject": "...", "relation": "...", "object": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], `Profile of ${name}`, profile);
}

// --- Dispositions ------------------------------------------------------
// PROVISIONAL WORDING, not yet tested against the user's model.

export function buildDispositionPrompt(currentMap, speaker, message) {
    const context = getContext();

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `Your job is to check a recent excerpt of the roleplay between ${context.name1} and ${context.name2} for lasting dispositions — what a character has come to feel, believe or expect — and to write them down if any exist. You are NOT continuing the roleplay, judging the content, or writing dialogue.`,
        },
        {
            heading: "## The test",
            content: `A disposition colours how a character behaves from now on, in situations the excerpt does not even mention: what they have stopped trusting, what they want, what they cannot stand, what a person or a subject has come to mean to them.

It is not a compulsion. The character can act against a disposition if they choose to — that is what separates it from an automatic reaction they have no say in.

A passing mood is not a disposition. Being annoyed right now is not one; having come to resent someone is.

The excerpt may contain zero, one, or several — check for all of them, across all characters present.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a disposition down if it is genuinely new, or if the excerpt changes one that is listed.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"disposition" is one short sentence in the present tense, stating what now holds for that character — "has stopped trusting Jacob", "dislikes being called Kimmy".`,
                "If the excerpt states what caused it, include it briefly only if stated — don't infer a cause that isn't in the text.",
                "No editorializing about how significant or surprising it is.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "disposition": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], speaker, message);
}

export function buildDispositionSeedPrompt(name, profile, currentMap) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "Your job is to read a character profile and write down the lasting dispositions it establishes — what the character feels, believes or expects going into the story. You are NOT continuing the roleplay, judging the content, or writing dialogue.",
        },
        {
            heading: "## The test",
            content: `A disposition colours how the character behaves in situations the profile does not even mention: what they have stopped trusting, what they want, what they cannot stand, what a person or a subject has come to mean to them.

It is not a compulsion. The character can act against a disposition if they choose to — that is what separates it from an automatic reaction they have no say in.

A skill or a habit is not a disposition, and neither is what the character looks like.

The profile may contain zero, one, or several — check for all of them.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a disposition down if it is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"disposition" is one short sentence in the present tense, stating what holds for that character — "distrusts anyone in uniform", "wants out of the city".`,
                "If the profile states what caused it, include it briefly only if stated — don't infer a cause that isn't in the text.",
                "No editorializing about how significant or surprising it is.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "disposition": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], `Profile of ${name}`, profile);
}

// PROVISIONAL WORDING, not yet tested against the user's model. Deliberately
// tiny: two entries in, one line out, with no list and no bookkeeping — which
// is the whole point of deciding at write time instead of compacting later.
export function buildKnowledgeMergePrompt(layer, existing, candidate) {
    const render = (entry) => layer.fields.map((field) => `${field}: ${entry[field]}`).join("\n");

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `You will see two entries from a ${layer.label.toLowerCase()} list that describe the same thing. Write the single entry that replaces them both.`,
        },
        {
            heading: "## Rules",
            content: bulletList([
                "The new entry must state everything both entries state — join them, never pick one and drop the other.",
                "Keep it as short as the originals, and in the same style.",
                "Add nothing that is not in one of the two entries.",
                "Reasoning is just for debug — one concise sentence is enough.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:\n{"reasoning": "...", ${layer.fields.map((field) => `"${field}": "..."`).join(", ")}}`,
        },
    ], "", `Entry A\n${render(existing)}\n\nEntry B\n${render(candidate)}`);
}

export function buildKnowledgeSchema(layer, reasoningDescription) {
    const properties = Object.fromEntries(
        layer.fields.map((field) => [field, { type: "string", description: layer.fieldDescriptions[field] }]),
    );
    const required = [...layer.fields];

    return {
        type: "object",
        properties: {
            reasoning: { type: "string", description: reasoningDescription },
            entries: {
                type: "array",
                description: "One object per entry. An empty array when there is nothing to record.",
                items: { type: "object", properties, required, additionalProperties: false },
            },
        },
        required: ["reasoning", "entries"],
        additionalProperties: false,
    };
}
