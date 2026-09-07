import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../events.js";
import { ConnectionManagerRequestService } from "../../shared.js";

const extensionName = "st-psychograph";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const STATE_AREAS = [
    { key: "clothes", id: "clothes" },
    { key: "physicalState", id: "physical_state" },
    { key: "stateOfMind", id: "state_of_mind" },
    { key: "situational", id: "situational" },
    { key: "expectations", id: "expectations" },
];

const CLOTHING_SLOTS = ["top", "bottom", "underwear", "legwear", "footwear", "accessories", "hair", "makeup"];
const CLOTHING_DIFF_MAX_TOKENS = 250;
const CLOTHING_SLOT_UPDATE_MAX_TOKENS = 200;

// "reasoning" is declared first (and listed first in `required`) so that on
// backends doing real grammar-constrained decoding, the model is forced to
// think through each category in prose BEFORE it has to commit to the
// booleans — a schema with the answer fields first forces a snap judgment
// with no way to reconsider. Key order matters here, not just presence.
const CLOTHING_DIFF_SCHEMA = {
    type: "object",
    properties: {
        reasoning: {
            type: "string",
            description: "One short clause per clothing category (top, bottom, underwear, legwear, footwear, accessories, hair, makeup, in that order), noting whether the message explicitly touches on it and why.",
        },
        top: { type: "boolean", description: "True if the message contains any explicit info about tops (shirts, jackets, coats, etc.) — new item, layering, removal, or state/damage change." },
        bottom: { type: "boolean", description: "True if the message mentions pants, skirts, shorts, a dress's lower half, etc. — same criteria as top." },
        underwear: { type: "boolean", description: "True if bra, panties, boxers, etc. are mentioned or implied to change." },
        legwear: { type: "boolean", description: "True if stockings, tights, socks, garters are mentioned or changed." },
        footwear: { type: "boolean", description: "True if shoes, boots, heels are mentioned, put on, or removed." },
        accessories: { type: "boolean", description: "True if jewelry, glasses, hats, belts, or similar are mentioned or changed." },
        hair: { type: "boolean", description: "True if hairstyle is described, mentioned, or changed (not just touched/moved)." },
        makeup: { type: "boolean", description: "True if makeup is applied, described, smeared, or removed." },
    },
    required: ["reasoning", ...CLOTHING_SLOTS],
    additionalProperties: false,
};

const CLOTHING_SLOT_UPDATE_SCHEMA = {
    type: "object",
    properties: {
        reasoning: {
            type: "string",
            description: "One short sentence working through which of the update rules below applies, before answering.",
        },
        state: {
            type: "string",
            description: "The full new state of this slot after applying the message. Comma-separated list of items if multiple. Use \"none\" if nothing is worn in this slot.",
        },
    },
    required: ["reasoning", "state"],
    additionalProperties: false,
};

function buildDefaultClothingDiffPrompt(message) {
    const exampleShape = JSON.stringify({
        reasoning: "...",
        ...Object.fromEntries(CLOTHING_SLOTS.map((slot) => [slot, false])),
    });

    return `Analyze ONLY the message below (not prior context). For each clothing
slot, determine whether the message contains any information about it.
Slots represent where clothing is worn, not specifically a category.
Important: Legwear covers the leg above the ankle, Footwear the foot.

If you find any change for a slot, mark it true. When there is no
change about the slot, mark it false.

Reasoning is just for debug, so one concise sentence is enough.

Message:
"""
${message}
"""

Respond with ONLY a JSON object (no markdown code fence). Fill in
"reasoning" first, then the 8 booleans, using exactly this shape:
${exampleShape}`;
}

function buildClothingSlotUpdatePrompt(slot, currentState, message) {
    return `Clothing slot "${slot}" (where clothing is worn, not a category).

Current state of ${slot}: "${currentState}"

Message: "${message}"

Update the ${slot} state based on this message.
- If a new item is added as a layer (e.g. a coat over a blouse), keep the
  existing item(s) and add the new one.
- If a new item explicitly replaces the existing one (e.g. "changes into a
  dress"), output only the new item(s).
- If the message describes a state/condition change to an existing item
  (stain, tear, wetness, damage), keep the item and add a short state tag
  in parentheses (max ~5 words), e.g. "white blouse (coffee stain)".
- If an item is explicitly removed and nothing replaces it, output "none".
- If nothing actually changed despite the trigger, return the state unchanged.
- Do not invent details that were not stated in the message.

Hint: There are multiple slots - you only have to concentrate on ${slot} though. Legwear covers the leg above the ankle, Footwear the foot. An accessory typically refers to an item worn to complement or enhance a garment or appearance.

Reasoning is just for debug, so one concise sentence is enough.

Respond with ONLY a JSON object (no markdown code fence). Fill in
"reasoning" first, then "state", using exactly this shape:
{"reasoning": "...", "state": "..."}.`;
}

const defaultSettings = {
    enabled: true,
    connectionProfile: "",
    cognee: {
        baseUrl: "",
        apiKey: "",
        enabled: false,
        recallEnabled: false,
    },
    state: {
        target: "char",
        areas: Object.fromEntries(
            STATE_AREAS.map(({ key }) => [key, { useDefaultPrompt: true, customPrompt: "" }]),
        ),
    },
};
defaultSettings.state.areas.clothes.slots = Object.fromEntries(CLOTHING_SLOTS.map((slot) => [slot, ""]));

function ensureSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    settings.cognee = Object.assign(structuredClone(defaultSettings.cognee), settings.cognee);
    settings.state = Object.assign({ target: defaultSettings.state.target }, settings.state);
    settings.state.areas = settings.state.areas || {};
    for (const { key } of STATE_AREAS) {
        const area = Object.assign(
            structuredClone(defaultSettings.state.areas[key]),
            settings.state.areas[key],
        );
        if (key === "clothes") {
            area.slots = Object.assign(
                structuredClone(defaultSettings.state.areas.clothes.slots),
                settings.state.areas.clothes?.slots,
            );
        }
        settings.state.areas[key] = area;
    }
    if (settings.enabled === undefined) {
        settings.enabled = defaultSettings.enabled;
    }
    if (settings.connectionProfile === undefined) {
        settings.connectionProfile = defaultSettings.connectionProfile;
    }

    return settings;
}

function populateConnectionProfiles() {
    const select = $("#psychograph_connection_profile");
    const settings = ensureSettings();
    const profiles = extension_settings.connectionManager?.profiles ?? [];

    select.empty();
    select.append($("<option>").val("").text("SillyTavern default"));
    for (const profile of profiles) {
        select.append($("<option>").val(profile.id).text(profile.name || profile.id));
    }

    select.val(settings.connectionProfile);
}

function renderSettings() {
    const settings = ensureSettings();
    $("#psychograph_enabled").prop("checked", settings.enabled);
    $("#psychograph_connection_profile").val(settings.connectionProfile);
    $("#psychograph_cognee_base_url").val(settings.cognee.baseUrl);
    $("#psychograph_cognee_api_key").val(settings.cognee.apiKey);
    $("#psychograph_cognee_enabled").prop("checked", settings.cognee.enabled);
    $("#psychograph_cognee_recall_enabled").prop("checked", settings.cognee.recallEnabled);
    renderCogneeChatSection();
    $("#psychograph_state_target").val(settings.state.target);

    for (const { key, id } of STATE_AREAS) {
        const area = settings.state.areas[key];
        $(`#psychograph_state_${id}_default_prompt`).prop("checked", area.useDefaultPrompt);
        $(`#psychograph_state_${id}_custom_prompt`).val(area.customPrompt).prop("hidden", area.useDefaultPrompt);
    }

    for (const slot of CLOTHING_SLOTS) {
        $(`#psychograph_state_clothes_slot_${slot}`).val(settings.state.areas.clothes.slots[slot]);
    }
}

function bindSettingsEvents() {
    $("#psychograph_enabled").on("change", function () {
        ensureSettings().enabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_connection_profile").on("change", function () {
        ensureSettings().connectionProfile = String($(this).val());
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_base_url").on("input", function () {
        ensureSettings().cognee.baseUrl = String($(this).val());
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_api_key").on("input", function () {
        ensureSettings().cognee.apiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_enabled").on("change", function () {
        ensureSettings().cognee.enabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_recall_enabled").on("change", function () {
        ensureSettings().cognee.recallEnabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_chat_id_set").on("click", function () {
        const value = String($("#psychograph_cognee_chat_id_input").val()).trim();
        if (!value) {
            return;
        }
        writeCogneeChatId(value);
        $("#psychograph_cognee_chat_id_input").val("");
        renderCogneeChatSection();
    });

    $("#psychograph_cognee_chat_id_regenerate").on("click", async function () {
        const context = getContext();
        const confirmed = await context.callGenericPopup(
            "Regenerate this chat's Cognee id? Future messages go to a new dataset; anything already sent stays under the old one.",
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        writeCogneeChatId(crypto.randomUUID());
        renderCogneeChatSection();
    });

    $("#psychograph_cognee_backfill").on("click", backfillChatHistoryToCognee);

    $("#psychograph_state_target").on("change", function () {
        ensureSettings().state.target = String($(this).val());
        saveSettingsDebounced();
    });

    for (const { key, id } of STATE_AREAS) {
        $(`#psychograph_state_${id}_default_prompt`).on("change", function () {
            const useDefaultPrompt = $(this).prop("checked");
            ensureSettings().state.areas[key].useDefaultPrompt = useDefaultPrompt;
            $(`#psychograph_state_${id}_custom_prompt`).prop("hidden", useDefaultPrompt);
            saveSettingsDebounced();
        });

        $(`#psychograph_state_${id}_custom_prompt`).on("input", function () {
            ensureSettings().state.areas[key].customPrompt = String($(this).val());
            saveSettingsDebounced();
        });
    }

    for (const slot of CLOTHING_SLOTS) {
        $(`#psychograph_state_clothes_slot_${slot}`).on("input", function () {
            ensureSettings().state.areas.clothes.slots[slot] = String($(this).val());
            saveSettingsDebounced();
        });
    }

    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, populateConnectionProfiles);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, populateConnectionProfiles);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, populateConnectionProfiles);
}

function parseJsonResponse(content) {
    const text = String(content).trim();
    try {
        return JSON.parse(text);
    } catch (error) {
        const withoutCodeFence = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
        const match = withoutCodeFence.match(/\{[\s\S]*\}/);
        if (!match) {
            throw error;
        }
        return JSON.parse(match[0]);
    }
}

async function sendJsonSchemaRequest(profileId, schemaName, schema, prompt, maxTokens) {
    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const overridePayload = profile.mode === "tc"
        ? { json_schema: schema }
        : { response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } } };

    const response = await ConnectionManagerRequestService.sendRequest(
        profileId,
        prompt,
        maxTokens,
        {},
        overridePayload,
    );

    return parseJsonResponse(response.content);
}

async function runClothingExtraction(message) {
    const settings = ensureSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) {
        console.warn("[Psychograph] Clothing extraction: no connection profile configured, skipping.");
        return;
    }

    const clothesArea = settings.state.areas.clothes;
    const diffPrompt = clothesArea.useDefaultPrompt
        ? buildDefaultClothingDiffPrompt(message)
        : clothesArea.customPrompt.replaceAll("{{message}}", message);

    let diff;
    try {
        diff = await sendJsonSchemaRequest(profileId, "clothing_diff", CLOTHING_DIFF_SCHEMA, diffPrompt, CLOTHING_DIFF_MAX_TOKENS);
        console.log("[Psychograph] Clothing diff reasoning:", diff.reasoning);
    } catch (error) {
        console.error("[Psychograph] Clothing diff call failed:", error);
        return;
    }

    const changedSlots = CLOTHING_SLOTS.filter((slot) => diff[slot] === true);
    if (changedSlots.length === 0) {
        return;
    }

    await Promise.all(changedSlots.map(async (slot) => {
        const currentState = clothesArea.slots[slot] || "none";
        const updatePrompt = buildClothingSlotUpdatePrompt(slot, currentState, message);

        try {
            const update = await sendJsonSchemaRequest(
                profileId,
                "clothing_slot_update",
                CLOTHING_SLOT_UPDATE_SCHEMA,
                updatePrompt,
                CLOTHING_SLOT_UPDATE_MAX_TOKENS,
            );
            console.log(`[Psychograph] Clothing update reasoning for "${slot}":`, update.reasoning);
            clothesArea.slots[slot] = update.state;
            $(`#psychograph_state_clothes_slot_${slot}`).val(update.state);
        } catch (error) {
            console.error(`[Psychograph] Clothing update call failed for slot "${slot}":`, error);
        }
    }));

    saveSettingsDebounced();
}

const COGNEE_METADATA_KEY = "stPsychograph";

// Stored in chat_metadata (saved inside the chat file itself) rather than
// derived from the chat's filename/chatId, so it survives a chat rename —
// this is the id that scopes a Cognee dataset/session to one specific
// roleplay instance, since the same character can have many separate chats.
function readCogneeChatId() {
    return getContext().chatMetadata[COGNEE_METADATA_KEY]?.cogneeChatId;
}

function writeCogneeChatId(id) {
    const context = getContext();
    context.chatMetadata[COGNEE_METADATA_KEY] = { ...context.chatMetadata[COGNEE_METADATA_KEY], cogneeChatId: id };
    context.saveMetadataDebounced();
}

function getCogneeChatId() {
    return readCogneeChatId() ?? (writeCogneeChatId(crypto.randomUUID()), readCogneeChatId());
}

function renderCogneeChatSection() {
    const id = readCogneeChatId();
    $("#psychograph_cognee_chat_id").text(id || "not set yet");
    $("#psychograph_cognee_chat_dataset").text(id ? `psychograph-chat-${id}` : "—");
}

// Explicit and small rather than trusting Cognee's default (4096): a dense
// chunk of packed RP dialogue can contain enough entities that a small local
// model's extraction response gets truncated before valid JSON closes (seen
// in practice as "finish_reason=length" + a schema-validation failure).
const COGNEE_CHUNK_SIZE = 1024;

async function sendMessageToCognee(texts, chatCogneeId) {
    const settings = ensureSettings();
    const formData = new FormData();
    for (const text of Array.isArray(texts) ? texts : [texts]) {
        formData.append("raw_data", text);
    }
    formData.append("datasetName", `psychograph-chat-${chatCogneeId}`);
    formData.append("session_id", chatCogneeId);
    formData.append("chunk_size", String(COGNEE_CHUNK_SIZE));

    const response = await fetch(`${settings.cognee.baseUrl.replace(/\/$/, "")}/api/v1/remember`, {
        method: "POST",
        headers: { "X-Api-Key": settings.cognee.apiKey },
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Cognee /remember failed: ${response.status} ${await response.text()}`);
    }

    console.log("[Psychograph] Sent message(s) to Cognee:", await response.json());
}

const cogneeIngestedMessages = new WeakSet();

async function handleCogneeIngestion() {
    const settings = ensureSettings();
    if (!settings.enabled || !settings.cognee.enabled || !settings.cognee.baseUrl || !settings.cognee.apiKey) {
        return;
    }

    const context = getContext();
    const chat = context.chat;
    const predecessor = chat[chat.length - 2];
    if (!predecessor || cogneeIngestedMessages.has(predecessor)) {
        return;
    }
    cogneeIngestedMessages.add(predecessor);

    const speaker = predecessor.name || (predecessor.is_user ? context.name1 : context.name2);
    const chatCogneeId = getCogneeChatId();

    try {
        await sendMessageToCognee(`${speaker}: ${predecessor.mes}`, chatCogneeId);
    } catch (error) {
        console.error("[Psychograph] Cognee ingestion failed:", error);
    }
}

let cogneeBackfillRunning = false;

// Reuses sendMessageToCognee() (the same /remember+session_id call the live
// predecessor hook makes) one message at a time, rather than bundling many
// messages into one call: each call's chunk is then bounded by a single
// message's length, which is naturally small — avoiding the truncation
// issue by construction instead of by tuning a batch/chunk size to guess
// around it. Also means backfill and live ingestion are one code path.
async function backfillChatHistoryToCognee() {
    if (cogneeBackfillRunning) {
        return;
    }

    const settings = ensureSettings();
    if (!settings.cognee.baseUrl || !settings.cognee.apiKey) {
        toastr.warning("Configure the Cognee base URL and API key first.", "Psychograph");
        return;
    }

    const context = getContext();
    const messages = context.chat.filter((m) => m.mes && m.mes.trim());
    if (messages.length === 0) {
        toastr.info("No messages in this chat yet.", "Psychograph");
        return;
    }

    const chatCogneeId = getCogneeChatId();
    cogneeBackfillRunning = true;
    $("#psychograph_cognee_backfill").addClass("disabled");

    try {
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const speaker = message.name || (message.is_user ? context.name1 : context.name2);
            await sendMessageToCognee(`${speaker}: ${message.mes}`, chatCogneeId);
            cogneeIngestedMessages.add(message);

            $("#psychograph_cognee_backfill_status").text(`Sent ${i + 1}/${messages.length}...`);
        }
        toastr.success(`Sent ${messages.length} messages to Cognee.`, "Psychograph");
    } catch (error) {
        console.error("[Psychograph] Backfill failed:", error);
        toastr.error("Backfill failed, see console for details.", "Psychograph");
    } finally {
        cogneeBackfillRunning = false;
        $("#psychograph_cognee_backfill").removeClass("disabled");
        $("#psychograph_cognee_backfill_status").text("");
    }
}

// Wording tuned for a graph-completion query, not an extraction prompt, but
// still empirically sensitive — see CLAUDE.md before changing this.
function buildCogneeRecallQuery(userName, charName) {
    return `This is an ongoing roleplay between ${userName} and ${charName}. Retrieve everything you know that is relevant for playing ${charName}'s next turn as realistically and consistently as possible — established relationships, unresolved plot threads, recent events, and ${charName}'s own goals, emotional state, and knowledge at this point in the story.`;
}

function buildCogneeRecallSystemPrompt(charName) {
    return `You are supporting an ongoing roleplay. Answer only with concrete facts and reminders that keep ${charName}'s next turn realistic and in-character — established relationships, unresolved threads, recent events, ${charName}'s goals and emotional state. Do not restate anything ${charName} would already obviously know or that's already common ground in the story — only surface what's actually useful to be reminded of. 2-4 short bullet points. Omit anything speculative or not actually grounded in what happened.`;
}

async function recallFromCognee(chatCogneeId) {
    const settings = ensureSettings();
    const context = getContext();

    const response = await fetch(`${settings.cognee.baseUrl.replace(/\/$/, "")}/api/v1/recall`, {
        method: "POST",
        headers: { "X-Api-Key": settings.cognee.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
            query: buildCogneeRecallQuery(context.name1, context.name2),
            system_prompt: buildCogneeRecallSystemPrompt(context.name2),
            datasets: [`psychograph-chat-${chatCogneeId}`],
            scope: "graph",
            search_type: "GRAPH_COMPLETION",
        }),
    });

    if (!response.ok) {
        throw new Error(`Cognee /recall failed: ${response.status} ${await response.text()}`);
    }

    const entries = await response.json();
    return entries.map((entry) => entry.text ?? entry.answer ?? entry.context ?? "").filter(Boolean).join("\n");
}

const COGNEE_RECALL_INJECT_ID = "psychograph_cognee_recall";
const COGNEE_RECALL_HEADING = "### Long-term context";

// Hooked on GENERATION_AFTER_COMMANDS (fires for Send/Swipe/Continue alike,
// awaited by SillyTavern before prompt assembly) so this network round trip
// still lands in the SAME upcoming turn rather than the next one. The actual
// /inject below uses depth=0 (tail of the chat section, right before the
// generation cursor) regardless of when in that window we call it — that's
// the latest position the injection mechanism offers, which keeps the rest
// of the prompt (system prompt, character card, world info, chat history)
// byte-identical to the previous turn for backends that reuse a KV/prompt
// cache across requests.
async function handleCogneeRecall(type, _options, dryRun) {
    const settings = ensureSettings();
    if (dryRun || type === "quiet" || !settings.enabled || !settings.cognee.recallEnabled || !settings.cognee.baseUrl || !settings.cognee.apiKey) {
        return;
    }

    try {
        const chatCogneeId = getCogneeChatId();
        const recalled = await recallFromCognee(chatCogneeId);
        if (!recalled) {
            return;
        }

        const injectedText = `${COGNEE_RECALL_HEADING}\n${recalled}`;
        console.log("[Psychograph] Cognee recall for next turn:", injectedText);
        toastr.info(injectedText, "Psychograph: Cognee recall", { timeOut: 8000 });

        await getContext().executeSlashCommandsWithOptions(
            `/inject id=${COGNEE_RECALL_INJECT_ID} position=chat ephemeral=true scan=true depth=0 role=system ${injectedText} |`,
        );
    } catch (error) {
        console.error("[Psychograph] Cognee recall failed:", error);
    }
}

async function flushCogneeRecallInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${COGNEE_RECALL_INJECT_ID} |`);
}

function isClothingTriggerRelevant(eventType) {
    const target = ensureSettings().state.target;
    if (target === "char") {
        return eventType === event_types.MESSAGE_RECEIVED || eventType === event_types.MESSAGE_SWIPED;
    }
    return eventType === event_types.MESSAGE_SENT;
}

function handleChatMessageEvent(eventType) {
    return async function () {
        const settings = ensureSettings();
        if (!settings.enabled || !isClothingTriggerRelevant(eventType)) {
            return;
        }

        const chat = getContext().chat;
        const lastMessage = chat[chat.length - 1];
        if (!lastMessage) {
            return;
        }

        await runClothingExtraction(lastMessage.mes);
    };
}

function bindChatEvents() {
    eventSource.on(event_types.MESSAGE_SENT, handleChatMessageEvent(event_types.MESSAGE_SENT));
    eventSource.on(event_types.MESSAGE_RECEIVED, handleChatMessageEvent(event_types.MESSAGE_RECEIVED));
    eventSource.on(event_types.MESSAGE_SWIPED, handleChatMessageEvent(event_types.MESSAGE_SWIPED));

    // Not bound on MESSAGE_SWIPED: swiping only changes the active swipe of
    // the *last* message, never its predecessor, so it would just resend
    // the same predecessor for no reason.
    eventSource.on(event_types.MESSAGE_SENT, handleCogneeIngestion);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleCogneeIngestion);

    eventSource.on(event_types.CHAT_CHANGED, renderCogneeChatSection);

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, handleCogneeRecall);
    eventSource.on(event_types.GENERATION_ENDED, flushCogneeRecallInject);
}

const GUIDED_INJECT_ID = "psychograph_guide";

async function withRestoredInput(action) {
    const textarea = document.getElementById("send_textarea");
    if (!textarea) {
        console.error("[Psychograph] Guided action: #send_textarea not found.");
        return;
    }

    const originalInput = textarea.value;
    try {
        await action(originalInput);
    } finally {
        textarea.value = originalInput;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

async function injectGuideText(text) {
    if (!text.trim()) {
        return false;
    }

    const context = getContext();
    await context.executeSlashCommandsWithOptions(
        `/inject id=${GUIDED_INJECT_ID} position=chat ephemeral=true scan=true depth=0 role=system ${text} |`,
    );
    return true;
}

async function flushGuideInject() {
    const context = getContext();
    await context.executeSlashCommandsWithOptions(`/flushinject ${GUIDED_INJECT_ID} |`);
}

async function guidedMessage() {
    await withRestoredInput(async (originalInput) => {
        const injected = await injectGuideText(originalInput);
        try {
            const context = getContext();
            await context.executeSlashCommandsWithOptions("/trigger await=true |");
        } finally {
            if (injected) {
                await flushGuideInject();
            }
        }
    });
}

async function guidedSwipe() {
    await withRestoredInput(async (originalInput) => {
        const injected = await injectGuideText(originalInput);
        try {
            const context = getContext();
            if (!context.swipe?.right) {
                toastr.error("This SillyTavern version doesn't support swipe.right().", "Psychograph");
                return;
            }
            await context.swipe.right();
        } finally {
            if (injected) {
                await flushGuideInject();
            }
        }
    });
}

async function guidedContinue() {
    await withRestoredInput(async (originalInput) => {
        const context = getContext();
        const command = originalInput.trim()
            ? `/continue await=true ${originalInput} |`
            : "/continue await=true |";
        await context.executeSlashCommandsWithOptions(command);
    });
}

async function rerunClothingExtractionNow() {
    const chat = getContext().chat;
    const lastMessage = chat[chat.length - 1];
    if (!lastMessage) {
        toastr.warning("No messages in this chat yet.", "Psychograph");
        return;
    }

    toastr.info("Analyzing clothing for the last message…", "Psychograph");
    await runClothingExtraction(lastMessage.mes);
}

async function initClothesFromDescription() {
    const settings = ensureSettings();
    const target = settings.state.target;

    const context = getContext();
    const fields = context.getCharacterCardFields();
    const description = target === "user" ? fields.persona : fields.description;

    if (!description || !description.trim()) {
        toastr.warning(
            target === "user" ? "No persona description found." : "No character description found.",
            "Psychograph",
        );
        return;
    }

    toastr.info("Initializing clothing state from description…", "Psychograph");
    await runClothingExtraction(description);
}

function togglePsychographSubmenu(anchorElement) {
    const submenu = $("#psychograph_submenu");

    if (submenu.hasClass("shown")) {
        submenu.removeClass("shown");
        return;
    }

    // position: absolute + getBoundingClientRect() + window.scrollX/Y, and
    // toggled via our own "shown" class rather than the `hidden` attribute —
    // this mirrors the GuidedGenerations extension's menu (confirmed working
    // in the same SillyTavern instance), because relying on `hidden` turned
    // out to be the actual bug: our container used SillyTavern's own
    // `.list-group` class, which SillyTavern's core CSS apparently styles
    // with a `display` that outranks the browser's default `[hidden]` rule
    // (both are author-level rules of equal specificity, so `[hidden]`
    // doesn't automatically win) — the submenu was never truly display:none,
    // just sitting whereever it was last positioned (or its unset default).
    const rect = anchorElement.getBoundingClientRect();
    submenu.css({
        top: `${rect.top + window.scrollY - 5}px`,
        left: `${rect.left + window.scrollX}px`,
    });
    submenu.addClass("shown");
}

function buildToolbarButton() {
    if ($("#psychograph_menu_button").length > 0) {
        return;
    }

    const nonQrFormItems = document.getElementById("nonQRFormItems");
    if (!nonQrFormItems) {
        console.warn("[Psychograph] Toolbar container (#nonQRFormItems) not found, skipping menu button.");
        return;
    }

    // A sibling container inserted right after #nonQRFormItems, the same
    // place/pattern the GuidedGenerations extension uses for its own button
    // row — puts our button next to it rather than squeezed into the plain
    // icon row (which also had a different, cramped layout context).
    let buttonContainer = document.getElementById("psychograph_button_container");
    if (!buttonContainer) {
        buttonContainer = document.createElement("div");
        buttonContainer.id = "psychograph_button_container";
        buttonContainer.className = "psychograph-button-container";
        nonQrFormItems.parentNode.insertBefore(buttonContainer, nonQrFormItems.nextSibling);
    }

    $(buttonContainer).append(`
        <div id="psychograph_menu_button" class="psychograph-toolbar-button fa-solid fa-brain interactable" title="Psychograph" tabindex="0"></div>
        <div class="psychograph-guided-buttons">
            <div id="psychograph_guided_swipe_button" class="psychograph-toolbar-button fa-solid fa-forward interactable" title="Guided Swipe" tabindex="0"></div>
            <div id="psychograph_guided_message_button" class="psychograph-toolbar-button fa-solid fa-comment-dots interactable" title="Guided Message" tabindex="0"></div>
            <div id="psychograph_guided_continue_button" class="psychograph-toolbar-button fa-solid fa-arrow-right interactable" title="Guided Continue" tabindex="0"></div>
        </div>
    `);

    $("#psychograph_guided_message_button").on("click", guidedMessage);
    $("#psychograph_guided_swipe_button").on("click", guidedSwipe);
    $("#psychograph_guided_continue_button").on("click", guidedContinue);

    $("body").append(`
        <div id="psychograph_submenu" class="psychograph-tools-menu">
            <div id="psychograph_action_clothes" class="list-group-item">
                <div class="fa-solid fa-shirt extensionsMenuExtensionButton"></div>
                <span>Clothes</span>
            </div>
            <div id="psychograph_action_init_clothes" class="list-group-item">
                <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div>
                <span>Init Clothes</span>
            </div>
        </div>
    `);

    $("#psychograph_menu_button").on("click", function (event) {
        event.stopPropagation();
        togglePsychographSubmenu(this);
    });

    $("#psychograph_submenu").on("click", function (event) {
        event.stopPropagation();
    });

    $(document).on("click", function () {
        $("#psychograph_submenu").removeClass("shown");
    });

    $("#psychograph_action_clothes").on("click", async function () {
        $("#psychograph_submenu").removeClass("shown");
        await rerunClothingExtractionNow();
    });

    $("#psychograph_action_init_clothes").on("click", async function () {
        $("#psychograph_submenu").removeClass("shown");
        await initClothesFromDescription();
    });
}

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);

    bindSettingsEvents();
    bindChatEvents();
    buildToolbarButton();
    renderSettings();
    populateConnectionProfiles();
});
