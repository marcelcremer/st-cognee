import { buildDispositionPrompt, buildDispositionSeedPrompt, buildFactPrompt, buildFactSeedPrompt, buildTriggerMapPrompt, buildTriggerSeedPrompt } from "../../prompts/knowledge.js";

// The three layers are one machine with three configurations: same table, same
// backfill and same card seeding. What is deliberately NOT shared is
// the model call — a 4B asked for three kinds at once gets less reliable, and
// a truncated mixed array drops whichever kind came last without looking like
// a failure.
export const KNOWLEDGE_LAYERS = {
    facts: {
        id: "facts",
        label: "Facts",
        fields: ["subject", "relation", "object"],
        fieldDescriptions: {
            subject: "Whoever or whatever the fact is about, by name.",
            relation: "The relation, short, lowercase and in the present tense.",
            object: "The other side of the relation.",
        },
        emptyPlaceholder: "Nothing known yet.",
        groupBy: "subject",
        renderEntry: (entry) => `${entry.relation} ${entry.object}`,
        injectHeading: "## Facts",
        injectIntro: "Those are additional facts that could be helpful for your next turn:",
        injectEntry: (entry) => `- ${entry.subject} ${entry.relation} ${entry.object}`,
        buildPrompt: buildFactPrompt,
        buildSeedPrompt: buildFactSeedPrompt,
    },
    dispositions: {
        id: "dispositions",
        label: "Dispositions",
        fields: ["character", "disposition"],
        fieldDescriptions: {
            character: "The character the disposition belongs to, by name.",
            disposition: "One short sentence stating what now holds for them.",
        },
        emptyPlaceholder: "Nothing known yet.",
        groupBy: "character",
        renderEntry: (entry) => entry.disposition,
        injectHeading: "## Dispositions",
        injectIntro: "These are known dispositions for the different Characters:",
        injectEntry: (entry) => `- ${entry.character} ${entry.disposition}`,
        buildPrompt: buildDispositionPrompt,
        buildSeedPrompt: buildDispositionSeedPrompt,
    },
    triggers: {
        id: "triggers",
        label: "Triggers",
        fields: ["character", "trigger", "response"],
        fieldDescriptions: {
            character: "The character the pattern belongs to, by name.",
            trigger: "The condition that sets the pattern off.",
            response: "What reliably happens when it does.",
        },
        emptyPlaceholder: "Nothing known yet.",
        groupBy: "character",
        renderEntry: (entry) => `${entry.trigger} -> ${entry.response}`,
        injectHeading: "## Triggers",
        injectIntro: "The following list of triggers will override the Characters behaviour involuntarily. Play the role accordingly:",
        injectEntry: (entry) => `- When ${entry.character} ${entry.trigger}: ${entry.response}`,
        buildPrompt: buildTriggerMapPrompt,
        buildSeedPrompt: buildTriggerSeedPrompt,
    },
};

export const KNOWLEDGE_KEYS = Object.keys(KNOWLEDGE_LAYERS);

export const KNOWLEDGE_ENTRY_MAX_TOKENS = 500;

// Budget scales with the input: a profile establishes far more at once than a
// single message does, and a truncated array comes back as invalid JSON, which
// loses every entry rather than the tail.
export function knowledgeBudgetFor(text) {
    return Math.min(1500, Math.max(KNOWLEDGE_ENTRY_MAX_TOKENS, Math.round(String(text).length / 4)));
}

export const KNOWLEDGE_MERGE_MAX_TOKENS = 250;
