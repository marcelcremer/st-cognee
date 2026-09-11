import { eventSource, event_types, getContext } from "./sillytavern.js";
import { flushCogneeRecallInject, flushContextInject, flushLegacyInjects, flushMotivationInject, handleCogneeRecall, handleInjectsForGeneration } from "./injects.js";
import { handleCogneeIngestion } from "./layers/cognee.js";
import { extractKnowledgeForNewMessage } from "./layers/knowledge/extraction.js";
import { KNOWLEDGE_KEYS, KNOWLEDGE_LAYERS } from "./layers/knowledge/layers.js";
import { readMotivationRoll } from "./layers/motivation/lottery.js";
import { extractStateForNewMessage } from "./layers/state/extraction.js";
import { extractTimelineForNewMessage } from "./layers/timeline/extraction.js";
import { NO_PROFILE_WARNING, warnOnce } from "./llm/request.js";
import { markMotivationRoll } from "./messages.js";
import { ensureSettings } from "./settings.js";
import { renderChatState, renderCogneeChatSection } from "./ui/settings-panel.js";
import { captureUndoSnapshot } from "./undo.js";

// Nothing here is awaited, and that is the point: emit() awaits every listener
// in turn, and sendMessageAsUser() awaits MESSAGE_SENT from inside Generate(),
// so awaiting the round would hold the reply until every extraction call has
// finished. Each layer marks its message and queues its work synchronously; the
// model calls happen in the lanes afterwards.
function startExtraction(work) {
    Promise.resolve(work).catch((error) => console.error("[Psychograph] Extraction failed:", error));
}

function handleChatMessageEvent() {
    return function () {
        const settings = ensureSettings();
        if (!settings.enabled) {
            return;
        }

        const profileId = settings.connectionProfile;
        if (!profileId) {
            warnOnce("profile:none", NO_PROFILE_WARNING);
            console.warn("[Psychograph] No connection profile configured, skipping extraction.");
            return;
        }

        captureUndoSnapshot("the last message");

        startExtraction(extractStateForNewMessage(settings, profileId));
        startExtraction(extractTimelineForNewMessage(settings, profileId));
        for (const key of KNOWLEDGE_KEYS) {
            startExtraction(extractKnowledgeForNewMessage(KNOWLEDGE_LAYERS[key], settings, profileId));
        }
    };
}

// The roll that was injected belongs to the message it produced, so it is
// stamped on the received one only - a sent message was written by the user.
function handleMotivationRecord(messageId) {
    const settings = ensureSettings();
    if (!settings.enabled || !settings.motivation.enabled) {
        return;
    }
    markMotivationRoll(getContext().chat[messageId], readMotivationRoll());
}

export function bindChatEvents() {
    eventSource.on(event_types.MESSAGE_SENT, handleChatMessageEvent());
    eventSource.on(event_types.MESSAGE_RECEIVED, handleChatMessageEvent());

    // Not bound on MESSAGE_SWIPED: it fires before a new swipe's text is
    // generated, while chat[].mes still holds the previous swipe's content.
    // MESSAGE_RECEIVED (type "swipe") already covers a finished swipe.
    eventSource.on(event_types.MESSAGE_SENT, handleCogneeIngestion);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleCogneeIngestion);

    eventSource.on(event_types.CHAT_CHANGED, renderCogneeChatSection);

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, handleCogneeRecall);
    eventSource.on(event_types.GENERATION_ENDED, flushCogneeRecallInject);

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, handleInjectsForGeneration);
    eventSource.on(event_types.GENERATION_ENDED, flushContextInject);
    eventSource.on(event_types.GENERATION_ENDED, flushMotivationInject);
    eventSource.on(event_types.CHAT_CHANGED, flushLegacyInjects);

    eventSource.on(event_types.MESSAGE_RECEIVED, handleMotivationRecord);

    // Slot inputs show the current chat's state — without this they'd keep
    // displaying whatever chat was open when the panel was last rendered.
    eventSource.on(event_types.CHAT_CHANGED, renderChatState);
}
