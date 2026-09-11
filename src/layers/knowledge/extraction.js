import { getContext } from "../../sillytavern.js";
import { ensureChatState, isCurrentChatState } from "../../chat-state.js";
import { NO_PROFILE_WARNING, backfillPool, sendJsonSchemaRequest } from "../../llm/request.js";
import { isKnowledgeExtracted, isTimelineMessage, markKnowledgeExtracted, readMessageSpeaker } from "../../messages.js";
import { buildKnowledgeSchema } from "../../prompts/knowledge.js";
import { ensureSettings } from "../../settings.js";
import { captureUndoSnapshot, noteLastExtraction } from "../../undo.js";
import { KNOWLEDGE_ENTRY_MAX_TOKENS, KNOWLEDGE_KEYS, KNOWLEDGE_LAYERS, knowledgeBudgetFor } from "./layers.js";
import { absorbKnowledgeEntries, queueKnowledgeWork, readKnowledgeEntries, readKnowledgeEntry, renderKnowledgeForPrompt } from "./store.js";

// Split in two on purpose: asking the model is the slow half and has no
// ordering constraint, while taking the answer in has one — a candidate has to
// be scored against the list as it stands, including what a call that finished
// a moment ago just added.
async function askForKnowledgeEntries(layer, profileId, prompt, maxTokens, label) {
    try {
        const schema = buildKnowledgeSchema(layer, "One concise sentence covering all findings, before answering.");
        const result = await sendJsonSchemaRequest(profileId, `${layer.id}_${label}`, schema, prompt, maxTokens);
        console.log(`[Psychograph] ${layer.label} ${label} reasoning:`, result.reasoning);

        return (Array.isArray(result.entries) ? result.entries : [])
            .map((entry) => readKnowledgeEntry(layer, entry))
            .filter(Boolean);
    } catch (error) {
        console.error(`[Psychograph] ${layer.label} ${label} call failed:`, error);
        return [];
    }
}

async function runKnowledgeCall(layer, profileId, prompt, maxTokens, label) {
    const chatState = ensureChatState();
    const found = await askForKnowledgeEntries(layer, profileId, prompt, maxTokens, label);
    return absorbKnowledgeEntries(layer, profileId, found, chatState);
}

function extractKnowledgeFromMessage(layer, profileId, message) {
    return runKnowledgeCall(
        layer,
        profileId,
        layer.buildPrompt(renderKnowledgeForPrompt(layer), readMessageSpeaker(message), message.mes),
        KNOWLEDGE_ENTRY_MAX_TOKENS,
        "message",
    );
}

// The character's own fields and the user persona are separate calls: one
// profile per call is what lets the model put a name on the entries.
function readKnowledgeSeedSources() {
    const context = getContext();
    const fields = context.getCharacterCardFields();

    return [
        { name: context.name2, text: [fields.description, fields.personality].filter(Boolean).join("\n\n") },
        { name: context.name1, text: fields.persona },
    ].filter((source) => source.name && String(source.text ?? "").trim());
}

async function seedKnowledgeFromCard(layer, profileId) {
    const sources = readKnowledgeSeedSources();
    if (sources.length === 0) {
        console.log(`[Psychograph] ${layer.label} seeding: nothing on the card to seed from, skipping.`);
        return 0;
    }

    let added = 0;
    for (const source of sources) {
        added += await runKnowledgeCall(
            layer,
            profileId,
            layer.buildSeedPrompt(source.name, source.text, renderKnowledgeForPrompt(layer)),
            knowledgeBudgetFor(source.text),
            "seed",
        );
    }
    return added;
}

export async function extractKnowledgeForNewMessage(layer, settings, profileId) {
    const layerSettings = settings.knowledge[layer.id];
    if (!layerSettings.autoExtract) {
        return;
    }

    const chatState = ensureChatState();
    const message = getContext().chat.at(-2);
    // Seeding runs before the first message is read rather than off a message
    // id, so it also works when the extension is switched on mid-chat.
    const needsSeed = !chatState.knowledge[layer.id].seeded;
    const readsMessage = isTimelineMessage(message, layerSettings.includeHidden)
        && !isKnowledgeExtracted(layer, message);
    if (!needsSeed && !readsMessage) {
        return;
    }

    if (needsSeed) {
        chatState.knowledge[layer.id].seeded = true;
    }
    if (readsMessage) {
        markKnowledgeExtracted(layer, message);
    }
    getContext().saveMetadataDebounced();

    await queueKnowledgeWork(layer, async () => {
        if (needsSeed) {
            await seedKnowledgeFromCard(layer, profileId);
        }
        if (!readsMessage) {
            return;
        }

        await extractKnowledgeFromMessage(layer, profileId, message);
    });
}

export async function rerunKnowledgeExtractionNow(layer) {
    const settings = ensureSettings();
    if (!settings.connectionProfile) {
        toastr.warning(NO_PROFILE_WARNING, "Psychograph");
        return;
    }

    const message = getContext().chat.at(-1);
    if (!isTimelineMessage(message, settings.knowledge[layer.id].includeHidden)) {
        toastr.warning("The last message is a system or hidden message, nothing to analyze.", "Psychograph");
        return;
    }

    toastr.info(`Checking the last message for ${layer.label.toLowerCase()}…`, "Psychograph");
    captureUndoSnapshot(`the ${layer.label.toLowerCase()} extraction`);
    const added = await queueKnowledgeWork(layer, () => extractKnowledgeFromMessage(layer, settings.connectionProfile, message));
    markKnowledgeExtracted(layer, message);
    noteLastExtraction(message, layer.label);

    if (added > 0) {
        toastr.success(`${added} new ${added === 1 ? "entry" : "entries"}.`, "Psychograph");
    } else {
        toastr.info(`Nothing for ${layer.label.toLowerCase()} in that message.`, "Psychograph");
    }
}

const knowledgeBuildRunning = {};

const knowledgeBuildCancelled = {};

const knowledgeBuildStatus = {};

function renderKnowledgeBuildStatus() {
    $("#psychograph_knowledge_status").text(
        KNOWLEDGE_KEYS.map((key) => knowledgeBuildStatus[key]).filter(Boolean).join(" · "),
    );
}

// The three layers never read each other's list, so their builds run side by
// side. Within a layer the calls stay in order: each one is handed the list so
// far as "already known", which is the only thing stopping the next message
// from recording what the previous one just did.
export async function buildAllKnowledge() {
    if (KNOWLEDGE_KEYS.some((key) => knowledgeBuildRunning[key])) {
        for (const key of KNOWLEDGE_KEYS) {
            knowledgeBuildCancelled[key] = true;
        }
        return;
    }

    $("#psychograph_knowledge_build").text("Stop");
    try {
        await Promise.all(KNOWLEDGE_KEYS.map((key) => buildKnowledge(KNOWLEDGE_LAYERS[key])));
    } finally {
        $("#psychograph_knowledge_build").text("Backfill");
    }
}

// Same shape as the timeline build, and for the same reason the list is handed
// to every call: nothing here dedupes in code, the list in the prompt does it.
async function buildKnowledge(layer) {
    if (knowledgeBuildRunning[layer.id]) {
        knowledgeBuildCancelled[layer.id] = true;
        return;
    }

    const settings = ensureSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) {
        toastr.warning(NO_PROFILE_WARNING, "Psychograph");
        return;
    }

    const layerSettings = settings.knowledge[layer.id];
    const messages = getContext().chat.filter((message) => isTimelineMessage(message, layerSettings.includeHidden));
    if (messages.length === 0) {
        toastr.info("No messages in this chat yet.", "Psychograph");
        return;
    }

    const chatState = ensureChatState();
    captureUndoSnapshot(`the ${layer.label.toLowerCase()} backfill`);
    knowledgeBuildRunning[layer.id] = true;
    knowledgeBuildCancelled[layer.id] = false;

    let added = 0;
    let done = 0;
    try {
        // Before message #0: what the card establishes may never come up in the
        // chat at all, and for a profile that is most of what there is to know.
        knowledgeBuildStatus[layer.id] = `${layer.label}: profile…`;
        renderKnowledgeBuildStatus();
        chatState.knowledge[layer.id].seeded = true;
        added += await queueKnowledgeWork(layer, () => seedKnowledgeFromCard(layer, profileId));

        // A sliding window rather than batches: with a barrier every four
        // messages the slots stand idle while the slowest call finishes and
        // the answers are taken in. Workers pull the next message as soon as
        // they are free, and the pool is what bounds how many calls are in
        // flight — across all three layers, not per layer.
        let next = 0;
        const workers = Array.from({ length: Math.max(1, ensureSettings().parallelRequests) }, async () => {
            while (true) {
                const index = next++;
                if (index >= messages.length || knowledgeBuildCancelled[layer.id] || !isCurrentChatState(chatState)) {
                    return;
                }

                const message = messages[index];
                const candidates = await backfillPool(() => askForKnowledgeEntries(
                    layer,
                    profileId,
                    layer.buildPrompt(renderKnowledgeForPrompt(layer), readMessageSpeaker(message), message.mes),
                    KNOWLEDGE_ENTRY_MAX_TOKENS,
                    "message",
                ));

                added += await queueKnowledgeWork(layer, () => absorbKnowledgeEntries(layer, profileId, candidates, chatState));
                markKnowledgeExtracted(layer, message);
                done += 1;
                knowledgeBuildStatus[layer.id] = `${layer.label} ${done}/${messages.length}, ${added} found`;
                renderKnowledgeBuildStatus();
            }
        });
        await Promise.all(workers);

        const summary = `${added} found, ${readKnowledgeEntries(layer).length} on the list.`;
        if (knowledgeBuildCancelled[layer.id]) {
            toastr.info(`Stopped. ${summary}`, "Psychograph");
        } else {
            toastr.success(`${layer.label} built: ${summary}`, "Psychograph");
        }
    } finally {
        knowledgeBuildRunning[layer.id] = false;
        knowledgeBuildStatus[layer.id] = "";
        renderKnowledgeBuildStatus();
    }
}
