import { getContext } from "../sillytavern.js";
import { buildPromptDocument, bulletList } from "./document.js";

// Shown in place of the entry list while the timeline is still empty: an empty
// section would be dropped from the document entirely, leaving the model
// without the heading the rules below refer back to.
const TIMELINE_EMPTY_PLACEHOLDER = "Nothing yet.";

// Under evaluation against the user's own model — see CLAUDE.md before
// touching any of this wording.
export function buildTimelinePrompt(currentTimeline, speaker, message) {
    const context = getContext();

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `Your job is to check a recent excerpt of the roleplay between ${context.name1} and ${context.name2} for a new fact worth adding to the timeline, and to write it if one exists. You are NOT continuing the roleplay, judging the content, or writing dialogue.`,
        },
        {
            heading: "## The test",
            content: `Ask yourself: if I skip this excerpt, what would I no longer know an hour from now that isn't already covered by an entry below — even in different words, or with a different specific trigger or example? Log only that — a new fact that now holds, a decision that was made, a state that changed.

If the excerpt only contains talking, asking, feeling, reacting, or restating/reinforcing something that's already true — without anything actually becoming true or false as a result — there is nothing to log yet. Set "significant" to false.

SARCASM: if something is exaggerated or not meant literally, don't record it as literal fact.`,
        },
        {
            heading: "## Already on the timeline",
            content: currentTimeline.trim() || TIMELINE_EMPTY_PLACEHOLDER,
        },
        {
            heading: "## Writing the entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                "One short sentence, neutral past tense, stating only what is now true — no framing of how important, surprising, or pivotal it is.",
                "Match the style of the existing entries above.",
                "Reasoning is just for debug — one concise sentence is enough.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:\n{"reasoning": "...", "significant": true | false, "entry": "..." | null}`,
        },
    ], speaker, message);
}

export function buildTimelineSchema() {
    return {
        type: "object",
        properties: {
            reasoning: {
                type: "string",
                description: "One concise sentence working through the test above, before answering.",
            },
            significant: {
                type: "boolean",
                description: "True if the excerpt establishes something the timeline does not already cover.",
            },
            entry: {
                type: ["string", "null"],
                description: "The new timeline entry as one short sentence, or null when there is nothing to log.",
            },
        },
        required: ["reasoning", "significant", "entry"],
        additionalProperties: false,
    };
}

// Deliberately context-free: the entry is judged on its own substance, not
// against the timeline it would join. Under evaluation against the user's own
// model — see CLAUDE.md before touching any of this wording.
export function buildTimelineKeepPrompt(entry) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "You will see a single candidate timeline entry, with no other context. Your job is to judge whether it's substantial enough to keep on a long-running story timeline, or whether it should be discarded as too minor.",
        },
        {
            heading: "## The test",
            content: "If you were a book summarizer who had to create a timeline of events - would you include this summary in your timeline or discard it?",
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:\n{"reasoning": "...", "keep": true | false}`,
        },
    ], "", entry);
}

export function buildTimelineKeepSchema() {
    return {
        type: "object",
        properties: {
            reasoning: {
                type: "string",
                description: "One concise sentence working through the test above, before answering.",
            },
            keep: {
                type: "boolean",
                description: "True if the entry is substantial enough for a long-running story timeline.",
            },
        },
        required: ["reasoning", "keep"],
        additionalProperties: false,
    };
}
