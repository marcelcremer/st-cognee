import { getContext } from "../../sillytavern.js";
import { ensureChatState, isCurrentChatState } from "../../chat-state.js";
import { MESSAGE_MODE, SEED_MODE } from "../../constants.js";
import { STATE_LANE, runInLane } from "../../extraction-queue.js";
import { refreshContextInject } from "../../injects.js";
import { NO_PROFILE_WARNING, sendJsonSchemaRequest, warnOnce } from "../../llm/request.js";
import { isStateExtracted, isStoryMessage, markStateExtracted, readMessageSpeaker } from "../../messages.js";
import { buildAreaDiffPrompt, buildAreaDiffSchema, buildAreaGatePrompt, buildAreaGateSchema, buildAreaSlotUpdatePrompt, buildAreaSlotUpdateSchema } from "../../prompts/state.js";
import { ensureSettings } from "../../settings.js";
import { captureUndoSnapshot, noteLastExtraction } from "../../undo.js";
import { AREA_DIFF_MAX_TOKENS, AREA_GATE_MAX_TOKENS, AREA_SLOT_CONFIGS, AREA_SLOT_UPDATE_MAX_TOKENS, EMPTY_SLOT_ANSWERS } from "./areas.js";

async function runAreaGate(profileId, eligibleAreaKeys, message, speaker) {
    if (eligibleAreaKeys.length === 0) {
        return [];
    }

    const prompt = buildAreaGatePrompt(eligibleAreaKeys, message, speaker);
    const schema = buildAreaGateSchema(eligibleAreaKeys);

    try {
        const gate = await sendJsonSchemaRequest(profileId, "area_gate", schema, prompt, AREA_GATE_MAX_TOKENS);
        console.log("[Psychograph] Area gate reasoning:", gate.reasoning);
        return eligibleAreaKeys.filter((key) => gate[key] === true);
    } catch (error) {
        // Extract nothing rather than everything: a failed gate is the one case
        // where running all areas is both the most expensive outcome and the
        // least informed one.
        console.error("[Psychograph] Area gate call failed, extracting nothing this turn:", error);
        return [];
    }
}

function normalizeSlotValue(config, value) {
    const text = String(value ?? "").trim();
    return EMPTY_SLOT_ANSWERS.has(text.toLowerCase()) ? config.emptyValue : text;
}

function expandTriggeredSlots(config, changedSlots) {
    const expanded = new Set(changedSlots);
    for (const slot of changedSlots) {
        for (const dependent of config.slotTriggers?.[slot] ?? []) {
            expanded.add(dependent);
        }
    }
    return config.slots.filter((slot) => expanded.has(slot));
}

async function runAreaExtraction(areaKey, message, speaker, mode = MESSAGE_MODE) {
    const settings = ensureSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) {
        warnOnce("profile:none", NO_PROFILE_WARNING);
        console.warn(`[Psychograph] ${areaKey} extraction: no connection profile configured, skipping.`);
        return;
    }

    const config = AREA_SLOT_CONFIGS[areaKey];
    const chatState = ensureChatState();
    const slots = mode === SEED_MODE
        ? config.slots.filter((slot) => !config.slotOverrides?.[slot]?.skipOnSeed)
        : config.slots;
    const diffPrompt = buildAreaDiffPrompt(config, slots, message, speaker, mode);
    const diffSchema = buildAreaDiffSchema(config, slots, mode);

    let diff;
    try {
        diff = await sendJsonSchemaRequest(profileId, `${areaKey}_diff`, diffSchema, diffPrompt, AREA_DIFF_MAX_TOKENS);
        console.log(`[Psychograph] ${config.label} diff reasoning:`, diff.reasoning);
    } catch (error) {
        console.error(`[Psychograph] ${config.label} diff call failed:`, error);
        return;
    }

    if (!isCurrentChatState(chatState)) {
        console.warn(`[Psychograph] Chat changed during the ${config.label} diff, discarding the result.`);
        return;
    }

    const changedSlots = expandTriggeredSlots(config, slots.filter((slot) => diff[slot] === true))
        .filter((slot) => slots.includes(slot));
    if (changedSlots.length === 0) {
        return;
    }

    const slotUpdateSchema = buildAreaSlotUpdateSchema(config, mode);
    await Promise.all(changedSlots.map(async (slot) => {
        const currentState = chatState.areas[areaKey].slots[slot] || config.slotDefaultSentinel(slot);
        const updatePrompt = buildAreaSlotUpdatePrompt(config, slot, currentState, message, speaker, mode);

        try {
            const update = await sendJsonSchemaRequest(
                profileId,
                `${areaKey}_slot_update`,
                slotUpdateSchema,
                updatePrompt,
                AREA_SLOT_UPDATE_MAX_TOKENS,
            );
            console.log(`[Psychograph] ${config.label} update reasoning for "${slot}":`, update.reasoning);
            if (!isCurrentChatState(chatState)) {
                console.warn(`[Psychograph] Chat changed during the ${config.label} update for "${slot}", discarding the result.`);
                return;
            }
            const value = normalizeSlotValue(config, update.state);
            chatState.areas[areaKey].slots[slot] = value;
            $(`#psychograph_state_${config.id}_slot_${slot}`).val(value);
        } catch (error) {
            console.error(`[Psychograph] ${config.label} update call failed for slot "${slot}":`, error);
        }
    }));

    if (!isCurrentChatState(chatState)) {
        return;
    }

    getContext().saveMetadataDebounced();
}

// Two overlapping runs would read the same slot values as their base and write
// back one after the other, so the later run's write would silently drop the
// earlier one's change. The lane is what keeps them apart - and it is a queue
// rather than a skip, because a skipped message is never offered again: the
// next trigger reads a different predecessor.
export function extractStateForNewMessage(settings, profileId) {
    const eligibleAreaKeys = Object.keys(AREA_SLOT_CONFIGS).filter((key) =>
        settings.state.areas[key].enabled);
    if (eligibleAreaKeys.length === 0) {
        return;
    }

    const chat = getContext().chat;
    // The newest message is still swipeable, and a swipe re-fires this event
    // with new text — extracting it would apply a second diff on top of state
    // the first run already moved. The predecessor is settled, so it can only
    // ever be extracted once.
    const message = chat[chat.length - 2];
    const needsSeed = !ensureChatState().seeded;
    const readsMessage = isStoryMessage(message) && !isStateExtracted(message);
    if (!needsSeed && !readsMessage) {
        return;
    }

    // Both markers are set here rather than inside the lane: the listener runs
    // again before the queued job does, and an unmarked message would be
    // queued a second time.
    if (needsSeed) {
        ensureChatState().seeded = true;
    }
    if (readsMessage) {
        markStateExtracted(message);
    }

    runInLane(STATE_LANE, async () => {
        if (needsSeed) {
            await seedChatStateFromCard(eligibleAreaKeys);
        }
        if (!readsMessage) {
            return;
        }

        const speaker = readMessageSpeaker(message);
        noteLastExtraction(message, "state");
        const gatedAreaKeys = await runAreaGate(profileId, eligibleAreaKeys, message.mes, speaker);
        await Promise.all(gatedAreaKeys.map((areaKey) => runAreaExtraction(areaKey, message.mes, speaker)));
        await refreshContextInject();
    });
}

export async function rerunAreaExtractionNow(areaKey) {
    const chat = getContext().chat;
    const lastMessage = chat[chat.length - 1];
    if (!lastMessage) {
        toastr.warning("No messages in this chat yet.", "Psychograph");
        return;
    }
    if (!isStoryMessage(lastMessage)) {
        toastr.warning("The last message is a system or hidden message, nothing to analyze.", "Psychograph");
        return;
    }

    // Queued in the same lane as the automatic pass rather than refused while
    // one is running: it reads the slot values as its base too, so it has to
    // take its turn, but a button press should not be thrown away.
    const config = AREA_SLOT_CONFIGS[areaKey];
    toastr.info(`Analyzing ${config.label.toLowerCase()} for the last message…`, "Psychograph");
    await runInLane(STATE_LANE, async () => {
        captureUndoSnapshot(`the ${config.label.toLowerCase()} extraction`);
        await runAreaExtraction(areaKey, lastMessage.mes, readMessageSpeaker(lastMessage));
        noteLastExtraction(lastMessage, config.label);
    });
}

function readAreaSeedText(config) {
    const fields = getContext().getCharacterCardFields();

    if (config.seedField === "scenario") {
        return { text: fields.scenario, missingLabel: "No scenario found." };
    }
    if (ensureChatState().target === "user") {
        return { text: fields.persona, missingLabel: "No persona description found." };
    }
    return { text: fields.description, missingLabel: "No character description found." };
}

// Seeding runs before the first message is processed rather than off a message
// id, so it also works when the extension is switched on mid-chat.
async function seedChatStateFromCard(eligibleAreaKeys) {
    const chatState = ensureChatState();
    chatState.seeded = true;
    getContext().saveMetadataDebounced();

    await Promise.all(eligibleAreaKeys.map(async (areaKey) => {
        const config = AREA_SLOT_CONFIGS[areaKey];
        const { text } = readAreaSeedText(config);
        if (!text || !text.trim()) {
            console.log(`[Psychograph] ${config.label} seeding: nothing on the card to seed from, skipping.`);
            return;
        }
        await runAreaExtraction(areaKey, text, "", SEED_MODE);
    }));
}
