import { getContext } from "./sillytavern.js";

// A /sys note or a hidden message is not story text: it must neither move
// slot state nor reach the graph.
export function isStoryMessage(message) {
    return Boolean(message) && !message.is_system && Boolean(String(message.mes ?? "").trim());
}

// SillyTavern's own chat-UI messages and /comment notes carry an extra.type,
// which a story message never does; "narrator" is the exception, since /sys
// writes story text.
function isChatUiMessage(message) {
    const type = message?.extra?.type;
    return Boolean(type) && type !== "narrator";
}

// /hide only flips is_system on an existing message, so hidden story text is
// otherwise a normal message — and it is still a record of something that
// happened, which is the one thing a timeline is about.
export function isTimelineMessage(message, includeHidden) {
    if (!message || !String(message.mes ?? "").trim() || isChatUiMessage(message)) {
        return false;
    }
    return includeHidden || !message.is_system;
}

const STATE_EXTRACTED_KEY = "psychographStateExtracted";

// The marker lives in message.extra, not in an in-memory set, so it survives a
// reload. saveMetadataDebounced() is what persists it: chat metadata is stored
// inside the chat file, so writing it writes the messages along with it.
export function isStateExtracted(message) {
    return Boolean(message?.extra?.[STATE_EXTRACTED_KEY]);
}

export function markStateExtracted(message) {
    message.extra = message.extra || {};
    message.extra[STATE_EXTRACTED_KEY] = true;
    getContext().saveMetadataDebounced();
}

const TIMELINE_EXTRACTED_KEY = "psychographTimelineExtracted";

export function isTimelineExtracted(message) {
    return Boolean(message?.extra?.[TIMELINE_EXTRACTED_KEY]);
}

export function markTimelineExtracted(message) {
    message.extra = message.extra || {};
    message.extra[TIMELINE_EXTRACTED_KEY] = true;
    getContext().saveMetadataDebounced();
}

// Whoever wrote a message may be describing someone else, so the speaker is
// an anchor for attribution, never a filter on which messages are read.
export function readMessageSpeaker(message) {
    const context = getContext();
    return message?.name || (message?.is_user ? context.name1 : context.name2) || "";
}

function knowledgeExtractedKey(layer) {
    return `psychographKnowledge_${layer.id}`;
}

export function isKnowledgeExtracted(layer, message) {
    return Boolean(message?.extra?.[knowledgeExtractedKey(layer)]);
}

export function markKnowledgeExtracted(layer, message) {
    message.extra = message.extra || {};
    message.extra[knowledgeExtractedKey(layer)] = true;
    getContext().saveMetadataDebounced();
}

const MOTIVATION_ROLL_KEY = "psychographMotivation";

// Which driver produced this message. Nothing reads it yet - it is the record
// the disposition layer needs, and only the turn that rolled it can write it.
export function markMotivationRoll(message, roll) {
    if (!message) {
        return;
    }
    message.extra = message.extra || {};
    message.extra[MOTIVATION_ROLL_KEY] = { driver: roll.driver, continuation: roll.continuation };
    getContext().saveMetadataDebounced();
}
