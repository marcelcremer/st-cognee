import { readTargetName } from "../chat-state.js";
import { SEED_MODE } from "../constants.js";

// The message goes last, after the rules, with its speaker on the line above
// it - the model reads the whole assignment before it ever sees the text it
// has to apply the assignment to.
export function buildPromptDocument(sections, speaker, message) {
    const body = sections
        .filter((section) => section && section.content)
        .map((section) => `${section.heading}\n${section.content}`)
        .join("\n\n");
    return `${body}\n---\n${speaker ? `${speaker}\n` : ""}${message}`;
}

export function bulletList(items) {
    return items.filter(Boolean).map((item) => `- ${item}`).join("\n");
}

export function qualifiedSlotName(config, slot) {
    return `"${config.label} / ${slot}"`;
}

// Naming the sheet's owner is what tells the model whose state it is filling
// in: with two people in a scene "she" is otherwise a guess, and extraction
// runs on every message regardless of who wrote it.
export function buildSheetIntro(config, focusPhrase, mode) {
    if (mode === SEED_MODE) {
        if (config.scope !== "character") {
            return `Your Job is to fill in the starting values of the scene sheet of a roleplay from its scenario. The scene sheet is slot-based and you only have to focus on ${focusPhrase}. The text below is the scenario the roleplay starts from, not a message from it.`;
        }
        return `Your Job is to fill in the starting values of the character sheet for ${readTargetName()} from their profile. The character sheet is slot-based and you only have to focus on ${focusPhrase}. The text below is a static profile, not a scene from the roleplay.`;
    }
    if (config.scope !== "character") {
        return `Your Job is to extract information for the scene sheet of an ongoing roleplay. The scene sheet is slot-based and you only have to focus on ${focusPhrase}.`;
    }
    return `Your Job is to extract information for the character sheet for ${readTargetName()}. The character sheet is slot-based and you only have to focus on ${focusPhrase}.`;
}

export function buildAttributionRule(config) {
    if (config.scope !== "character") {
        return null;
    }
    const target = readTargetName();
    return `Only information about ${target} counts - information about anyone else does not.`;
}

export function buildHintSection(config) {
    return {
        heading: "## Additional hints",
        content: bulletList([
            ...(config.hints ?? []),
            "Reasoning is just for debug, so one concise sentence is enough.",
        ]),
    };
}
