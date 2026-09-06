import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../events.js";
import { ConnectionManagerRequestService } from "../../shared.js";

const extensionName = "st-psychograph";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const STATE_AREAS = [
    { key: "general", id: "general" },
    { key: "clothes", id: "clothes" },
    { key: "physicalState", id: "physical_state" },
    { key: "stateOfMind", id: "state_of_mind" },
    { key: "situational", id: "situational" },
    { key: "expectations", id: "expectations" },
];

const CLOTHING_SLOTS = ["top", "bottom", "underwear", "legwear", "footwear", "accessories", "hair", "makeup"];
const CLOTHING_DIFF_MAX_TOKENS = 200;
const CLOTHING_SLOT_UPDATE_MAX_TOKENS = 150;

const CLOTHING_DIFF_SCHEMA = {
    type: "object",
    properties: {
        top: { type: "boolean", description: "True if the message contains any explicit info about tops (shirts, jackets, coats, etc.) — new item, layering, removal, or state/damage change." },
        bottom: { type: "boolean", description: "True if the message mentions pants, skirts, shorts, a dress's lower half, etc. — same criteria as top." },
        underwear: { type: "boolean", description: "True if bra, panties, boxers, etc. are mentioned or implied to change." },
        legwear: { type: "boolean", description: "True if stockings, tights, socks, garters are mentioned or changed." },
        footwear: { type: "boolean", description: "True if shoes, boots, heels are mentioned, put on, or removed." },
        accessories: { type: "boolean", description: "True if jewelry, glasses, hats, belts, or similar are mentioned or changed." },
        hair: { type: "boolean", description: "True if hairstyle is described, mentioned, or changed (not just touched/moved)." },
        makeup: { type: "boolean", description: "True if makeup is applied, described, smeared, or removed." },
    },
    required: CLOTHING_SLOTS,
    additionalProperties: false,
};

const CLOTHING_SLOT_UPDATE_SCHEMA = {
    type: "object",
    properties: {
        state: {
            type: "string",
            description: "The full new state of this slot after applying the message. Comma-separated list of items if multiple. Use \"none\" if nothing is worn in this slot.",
        },
    },
    required: ["state"],
    additionalProperties: false,
};

function buildDefaultClothingDiffPrompt(message) {
    const exampleShape = JSON.stringify(Object.fromEntries(CLOTHING_SLOTS.map((slot) => [slot, false])));

    return `Analyze ONLY the message below (not prior context). For each clothing category,
determine whether the message contains explicit information about it — a
description, addition, removal, or state/condition change (stain, tear,
wetness, damage) to an existing item.

Do not infer from context outside this message. A character simply moving,
speaking, or being described emotionally does NOT count unless clothing,
hair, or makeup is explicitly touched on. When in doubt, false.

Message:
"""
${message}
"""

Respond with ONLY a JSON object (no explanation, no markdown code fence),
using exactly this shape — all 8 keys present, true/false values only:
${exampleShape}`;
}

function buildClothingSlotUpdatePrompt(slot, currentState, message) {
    return `Current state of ${slot}: "${currentState}"

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

Respond with ONLY a JSON object (no explanation, no markdown code fence)
of the form {"state": "..."}.`;
}

const defaultSettings = {
    enabled: true,
    connectionProfile: "",
    cognee: {
        baseUrl: "",
        apiKey: "",
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
            clothesArea.slots[slot] = update.state;
            $(`#psychograph_state_clothes_slot_${slot}`).val(update.state);
        } catch (error) {
            console.error(`[Psychograph] Clothing update call failed for slot "${slot}":`, error);
        }
    }));

    saveSettingsDebounced();
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

function togglePsychographWandSubmenu(anchorElement) {
    const submenu = $("#psychograph_wand_submenu");
    const wasHidden = submenu.prop("hidden");
    submenu.prop("hidden", true);
    if (!wasHidden) {
        return;
    }

    const offset = $(anchorElement).offset();
    submenu.css({
        top: offset.top,
        left: offset.left + $(anchorElement).outerWidth(),
    });
    submenu.prop("hidden", false);
}

function buildWandMenu() {
    const wandMenu = $("#extensionsMenu");
    if (wandMenu.length === 0) {
        console.warn("[Psychograph] Wand menu (#extensionsMenu) not found, skipping menu button.");
        return;
    }

    wandMenu.append(`
        <div id="psychograph_wand_menu_item" class="list-group-item flex-container flexGap5" title="Psychograph">
            <div class="fa-solid fa-brain extensionsMenuExtensionButton"></div>
            <span>Psychograph</span>
        </div>
    `);

    $("body").append(`
        <div id="psychograph_wand_submenu" class="list-group" hidden>
            <div id="psychograph_wand_action_clothes" class="list-group-item flex-container flexGap5">
                <div class="fa-solid fa-shirt extensionsMenuExtensionButton"></div>
                <span>Clothes</span>
            </div>
        </div>
    `);

    $("#psychograph_wand_menu_item").on("click", function (event) {
        event.stopPropagation();
        togglePsychographWandSubmenu(this);
    });

    $("#psychograph_wand_submenu").on("click", function (event) {
        event.stopPropagation();
    });

    $(document).on("click", function () {
        $("#psychograph_wand_submenu").prop("hidden", true);
    });

    $("#psychograph_wand_action_clothes").on("click", async function () {
        $("#psychograph_wand_submenu").prop("hidden", true);
        await rerunClothingExtractionNow();
    });
}

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);

    bindSettingsEvents();
    bindChatEvents();
    buildWandMenu();
    renderSettings();
    populateConnectionProfiles();
});
