import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../events.js";
import { ConnectionManagerRequestService } from "../../shared.js";

const extensionName = "st-psychograph";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const STATE_AREAS = [
    { key: "clothes", id: "clothes" },
    { key: "physicalState", id: "physical_state" },
    { key: "situational", id: "situational" },
];

const CLOTHING_SLOTS = ["top", "bottom", "underwear", "legwear", "footwear", "accessories", "hair", "makeup"];
const PHYSICAL_STATE_SLOTS = ["condition", "constraint", "bodyChanges"];
const SITUATIONAL_SLOTS = ["location", "presentPeople", "timeOfDay"];

const AREA_DIFF_MAX_TOKENS = 250;
const AREA_SLOT_UPDATE_MAX_TOKENS = 200;
const AREA_GATE_MAX_TOKENS = 200;

// Values a model reaches for when a slot holds nothing. Outside Clothes these
// are an absence and must not reach the prompt; inside Clothes "none" is itself
// the information (a bare slot is what the scene is about), see emptyValue.
const EMPTY_SLOT_ANSWERS = new Set(["none", "nothing", "n/a", "na", "unknown", "not established", "-", "keine", "nichts"]);

// Per-area config for the generic diff -> per-slot-update pipeline. Clothes'
// own prompt *wording* below is copied verbatim from the original
// clothing-only implementation (issue #2) and must stay byte-for-byte
// identical - only the mechanical scaffolding around it (this config table,
// the generic builders below) is new. See CLAUDE.md: extraction-prompt
// wording is empirically tuned per user/model and requires sign-off before
// changing, so don't "clean up" Clothes' text even if it looks inconsistent
// with the newer areas' leaner style.
const AREA_SLOT_CONFIGS = {
    clothes: {
        scope: "character",
        id: "clothes",
        label: "Clothes",
        icon: "fa-shirt",
        slots: CLOTHING_SLOTS,
        triggerMode: "target",
        seedField: "target",
        diffIntroParagraph: `Analyze ONLY the message below (not prior context). For each clothing
slot, determine whether the message contains any information about it.
Slots represent where clothing is worn, not specifically a category.
Important: Legwear covers the leg above the ankle, Footwear the foot.`,
        diffTrueFalseLine: `If you find any change for a slot, mark it true. When there is no
change about the slot, mark it false.`,
        diffReasoningDescription: "One short clause per clothing category (top, bottom, underwear, legwear, footwear, accessories, hair, makeup, in that order), noting whether the message explicitly touches on it and why.",
        slotDescriptions: {
            top: "True if the message contains any explicit info about tops (shirts, jackets, coats, etc.) — new item, layering, removal, or state/damage change.",
            bottom: "True if the message mentions pants, skirts, shorts, a dress's lower half, etc. — same criteria as top.",
            underwear: "True if bra, panties, boxers, etc. are mentioned or implied to change.",
            legwear: "True if stockings, tights, socks, garters are mentioned or changed.",
            footwear: "True if shoes, boots, heels are mentioned, put on, or removed.",
            accessories: "True if jewelry, glasses, hats, belts, or similar are mentioned or changed.",
            hair: "True if hairstyle is described, mentioned, or changed (not just touched/moved).",
            makeup: "True if makeup is applied, described, smeared, or removed.",
        },
        slotLabel: (slot) => `Clothing slot "${slot}" (where clothing is worn, not a category).`,
        updateRules: `- If a new item is added as a layer (e.g. a coat over a blouse), keep the
  existing item(s) and add the new one.
- If a new item explicitly replaces the existing one (e.g. "changes into a
  dress"), output only the new item(s).
- If the message describes a state/condition change to an existing item
  (stain, tear, wetness, damage), keep the item and add a short state tag
  in parentheses (max ~5 words), e.g. "white blouse (coffee stain)".
- If an item is explicitly removed and nothing replaces it, output "none".
- If nothing actually changed despite the trigger, return the state unchanged.
- Do not invent details that were not stated in the message.`,
        updateHint: (slot) => `Hint: There are multiple slots - you only have to concentrate on ${slot} though. Legwear covers the leg above the ankle, Footwear the foot. An accessory typically refers to an item worn to complement or enhance a garment or appearance.`,
        slotUpdateStateDescription: "The full new state of this slot after applying the message. Comma-separated list of items if multiple. Use \"none\" if nothing is worn in this slot.",
        slotDefaultSentinel: () => "none",
        gateDescription: "True if the message contains information about what a character is wearing, or a change to it.",
        // The only area where "none" is a value rather than an absence: a bare
        // slot is what the scene is about, so it has to reach the prompt.
        emptyValue: "none",
    },
    physicalState: {
        scope: "character",
        id: "physical_state",
        label: "Body",
        icon: "fa-heart-pulse",
        slots: PHYSICAL_STATE_SLOTS,
        triggerMode: "always",
        seedField: "target",
        emptyValue: "",
        diffIntroParagraph: `For each slot below, determine whether the message contains any
information about it. Slots track the character's body and what
currently limits their ability to act.`,
        diffTrueFalseLine: "If you find any information for a slot, mark it true. Otherwise mark it false.",
        diffReasoningDescription: "One short clause per slot (condition, constraint, bodyChanges, in that order), noting whether the message contains information about it and why.",
        slotDescriptions: {
            condition: "True if the message contains information about the character's temporary bodily state — injury, illness, exhaustion, hunger, or intoxication.",
            constraint: "True if the message contains information about what currently limits the character's freedom to act — being restrained, confined, guarded, or under an obligation they cannot simply walk away from.",
            bodyChanges: "True if the message establishes a lasting change to the character's body compared to how they are described in their profile, whether deliberate (a tattoo, a piercing) or not (weight, a scar, visible aging).",
        },
        slotLabel: (slot) => `Body slot "${slot}".`,
        updateRules: `- If the message adds new information, incorporate it into the existing state.
- If the message explicitly resolves or ends what the slot describes, output "none".
- If nothing actually changed despite the trigger, return the state unchanged.
- Do not invent details that were not stated in the message.`,
        slotOverrides: {
            // Only slot that stores a delta rather than a value, so it is the
            // only one whose update call needs the profile it is a delta against.
            bodyChanges: {
                context: () => `Profile description of the tracked character:\n"""\n${readTargetProfileText()}\n"""`,
                updateRules: `- Output ONLY how the body now differs from the profile above. Never repeat
  anything the profile already says.
- If the message establishes a new lasting change, append it to the existing
  entries, separated by "; ".
- Keep existing entries unless the message explicitly reverses one.
- If nothing lasting changed, return the entries unchanged.
- Output "none" if the body does not differ from the profile at all.`,
            },
        },
        slotUpdateStateDescription: "The new value of this slot after applying the update rules above.",
        slotDefaultSentinel: () => "none",
        gateDescription: "True if the message contains information about a character's bodily condition, what limits their freedom to act, or a lasting change to their body.",
    },
    situational: {
        scope: "scene",
        id: "situational",
        label: "Scene",
        icon: "fa-location-dot",
        slots: SITUATIONAL_SLOTS,
        triggerMode: "always",
        seedField: "scenario",
        emptyValue: "",
        diffIntroParagraph: `For each slot below, determine whether the message contains any
information about it. Slots describe the scene the characters are
currently in - where they are, who is with them, and when it is -
not their actions or dialogue.`,
        diffTrueFalseLine: "If you find any information for a slot, mark it true. Otherwise mark it false.",
        diffReasoningDescription: "One short clause per slot (location, presentPeople, timeOfDay, in that order), noting whether the message contains information about it and why.",
        slotDescriptions: {
            location: "True if the message states or changes where the characters are, or how private, exposed, or safe that place is.",
            presentPeople: "True if the message states that someone is present in the scene, arrives, or leaves.",
            timeOfDay: "True if the message explicitly states or unambiguously implies the time of day.",
        },
        slotLabel: (slot) => `Scene slot "${slot}".`,
        updateRules: `- If the message establishes new information, incorporate it into the state.
- If the message explicitly changes this aspect of the scene, replace the state with the new value.
- If nothing actually changed despite the trigger, return the state unchanged.
- Do not invent or infer details that were not explicitly stated.`,
        slotOverrides: {
            presentPeople: {
                updateRules: `- Write out the full list of everyone present after applying the message.
- Keep everyone who was already present unless the message says they left.
- Add anyone the message says arrived or is present.
- Separate names with ", ".
- Do not invent people who were not named.`,
            },
        },
        // A scene cut ("she drove home") changes the cast without naming anyone,
        // so the location trigger has to pull presentPeople along or the old cast
        // stays in the list forever.
        slotTriggers: { location: ["presentPeople"] },
        slotUpdateStateDescription: "The new value of this slot after applying the update rules above.",
        slotDefaultSentinel: (slot) => {
            if (slot !== "presentPeople") return "none";
            const context = getContext();
            return [context.name1, context.name2].filter(Boolean).join(", ") || "none";
        },
        gateDescription: "True if the message contains information about where the characters are, who is with them, or what time it is.",
    },
};

// bodyChanges stores a delta against the character profile, so the profile has
// to be in the update call - the full card, deliberately, since a trimmed
// summary would decide for the model what counts as a physical detail.
function readTargetProfileText() {
    const fields = getContext().getCharacterCardFields();
    return (ensureChatState().target === "user" ? fields.persona : fields.description) || "";
}

function buildAreaDiffPrompt(config, message) {
    const exampleShape = JSON.stringify({
        reasoning: "...",
        ...Object.fromEntries(config.slots.map((slot) => [slot, false])),
    });
    const countPhrase = config.slots.length === 1 ? "the boolean" : `the ${config.slots.length} booleans`;

    return [
        config.diffIntroParagraph,
        config.diffTrueFalseLine,
        "Reasoning is just for debug, so one concise sentence is enough.",
        `Message:\n"""\n${message}\n"""`,
        `Respond with ONLY a JSON object (no markdown code fence). Fill in\n"reasoning" first, then ${countPhrase}, using exactly this shape:\n${exampleShape}`,
    ].join("\n\n");
}

function buildAreaDiffSchema(config) {
    const properties = {
        reasoning: { type: "string", description: config.diffReasoningDescription },
    };
    for (const slot of config.slots) {
        properties[slot] = { type: "boolean", description: config.slotDescriptions[slot] };
    }
    return {
        type: "object",
        properties,
        required: ["reasoning", ...config.slots],
        additionalProperties: false,
    };
}

function buildAreaSlotUpdatePrompt(config, slot, currentState, message) {
    const overrides = config.slotOverrides?.[slot] ?? {};
    const blocks = [config.slotLabel(slot)];
    if (overrides.context) {
        blocks.push(overrides.context());
    }
    blocks.push(
        `Current state of ${slot}: "${currentState}"`,
        `Message: "${message}"`,
        `Update the ${slot} state based on this message.\n${overrides.updateRules ?? config.updateRules}`,
    );
    if (config.updateHint) {
        blocks.push(config.updateHint(slot));
    }
    blocks.push(
        "Reasoning is just for debug, so one concise sentence is enough.",
        "Respond with ONLY a JSON object (no markdown code fence). Fill in\n\"reasoning\" first, then \"state\", using exactly this shape:\n{\"reasoning\": \"...\", \"state\": \"...\"}.",
    );
    return blocks.join("\n\n");
}

function buildAreaSlotUpdateSchema(config) {
    return {
        type: "object",
        properties: {
            reasoning: {
                type: "string",
                description: "One short sentence working through which of the update rules below applies, before answering.",
            },
            state: { type: "string", description: config.slotUpdateStateDescription },
        },
        required: ["reasoning", "state"],
        additionalProperties: false,
    };
}

function buildAreaGatePrompt(eligibleAreaKeys, message) {
    const exampleShape = JSON.stringify({
        reasoning: "...",
        ...Object.fromEntries(eligibleAreaKeys.map((key) => [key, false])),
    });
    const countPhrase = eligibleAreaKeys.length === 1 ? "the boolean" : `the ${eligibleAreaKeys.length} booleans`;

    return [
        "For each area below, determine whether the message contains any\ninformation relevant to it.",
        "If you find any information relevant to an area, mark it true.\nOtherwise mark it false.",
        "Reasoning is just for debug, so one concise sentence is enough.",
        `Message:\n"""\n${message}\n"""`,
        `Respond with ONLY a JSON object (no markdown code fence). Fill in\n"reasoning" first, then ${countPhrase}, using exactly this shape:\n${exampleShape}`,
    ].join("\n\n");
}

function buildAreaGateSchema(eligibleAreaKeys) {
    const properties = {
        reasoning: {
            type: "string",
            description: "One short clause per area, in order, noting whether the message contains information relevant to it and why.",
        },
    };
    for (const key of eligibleAreaKeys) {
        properties[key] = { type: "boolean", description: AREA_SLOT_CONFIGS[key].gateDescription };
    }
    return {
        type: "object",
        properties,
        required: ["reasoning", ...eligibleAreaKeys],
        additionalProperties: false,
    };
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
        areas: Object.fromEntries(
            STATE_AREAS.map(({ key }) => [key, { useDefaultPrompt: true, customPrompt: "", enabled: true }]),
        ),
    },
};

// Which side of the conversation "Applies to" tracks — char or user —
// varies by chat/scenario (sometimes the game drives the user, sometimes
// the user drives the game), so it belongs in chat_metadata alongside the
// slot values, not in the global settings.
const DEFAULT_TARGET = "char";

// Slot *values* belong to the conversation, not the user profile — they
// live in chat_metadata (see ensureChatState() below), not in
// extension_settings. Only the configuration above (enabled, prompts,
// connection) is a global preference that should apply across every chat.
// This mirrors how SillyTavern's own Author's Note feature splits its data:
// global defaults in extension_settings, the actual per-conversation values
// namespaced under chat_metadata[extensionName] (public/scripts/authors-note.js).
const DEFAULT_AREA_SLOTS = Object.fromEntries(
    STATE_AREAS.map(({ key }) => [key, Object.fromEntries(AREA_SLOT_CONFIGS[key].slots.map((slot) => [slot, ""]))]),
);

function ensureSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    settings.cognee = Object.assign(structuredClone(defaultSettings.cognee), settings.cognee);
    settings.state = settings.state || {};
    settings.state.areas = settings.state.areas || {};
    for (const { key } of STATE_AREAS) {
        settings.state.areas[key] = Object.assign(
            structuredClone(defaultSettings.state.areas[key]),
            settings.state.areas[key],
        );
    }
    if (settings.enabled === undefined) {
        settings.enabled = defaultSettings.enabled;
    }
    if (settings.connectionProfile === undefined) {
        settings.connectionProfile = defaultSettings.connectionProfile;
    }

    return settings;
}

// Per-chat slot state, namespaced under chat_metadata[extensionName] so it
// travels with the chat file (saved/loaded/exported with the chat) instead
// of leaking between conversations. Always call getContext() fresh here —
// chat_metadata is reassigned wholesale on chat switch/reset, so a cached
// reference would silently point at a stale, orphaned object.
function ensureChatState() {
    const chatMetadata = getContext().chatMetadata;
    if (!chatMetadata[extensionName]) {
        chatMetadata[extensionName] = {};
    }

    const chatState = chatMetadata[extensionName];
    chatState.target = chatState.target || DEFAULT_TARGET;
    chatState.areas = chatState.areas || {};
    migrateChatAreas(chatState);
    for (const { key } of STATE_AREAS) {
        const stored = chatState.areas[key]?.slots ?? {};
        chatState.areas[key] = {
            slots: Object.fromEntries(
                AREA_SLOT_CONFIGS[key].slots.map((slot) => [slot, stored[slot] ?? DEFAULT_AREA_SLOTS[key][slot]]),
            ),
        };
    }

    return chatState;
}

const LEGACY_AREAS_KEY = "legacyAreas";

// The slot layout changed (26 slots across 5 areas -> 14 across 3). Old values
// are parked instead of dropped: State of Mind and Expectations are append-only
// records that belong in a later layer, not in an overwrite snapshot, and this
// is the only copy of them.
function migrateChatAreas(chatState) {
    const areas = chatState.areas;
    const oldBody = areas.physicalState?.slots;
    const oldScene = areas.situational?.slots;
    if (!(oldBody && "health" in oldBody) && !(oldScene && "privacyRisk" in oldScene)) {
        return;
    }

    chatState[LEGACY_AREAS_KEY] = structuredClone(areas);

    const carry = (...values) => values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value && !EMPTY_SLOT_ANSWERS.has(value.toLowerCase()))
        .join("; ");

    areas.physicalState = {
        slots: {
            condition: carry(oldBody?.health, oldBody?.marks),
            constraint: carry(oldBody?.restraints),
            bodyChanges: "",
        },
    };
    areas.situational = {
        slots: {
            location: carry(oldScene?.location, oldScene?.features, oldScene?.privacyRisk),
            presentPeople: "",
            timeOfDay: carry(oldScene?.timeOfDay),
        },
    };
    delete areas.stateOfMind;
    delete areas.expectations;
    console.log("[Psychograph] Migrated chat state to the reduced slot layout; previous values kept under", LEGACY_AREAS_KEY);
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

    for (const { key, id } of STATE_AREAS) {
        const area = settings.state.areas[key];
        $(`#psychograph_state_${id}_enabled`).prop("checked", area.enabled);
        $(`#psychograph_state_${id}_default_prompt`).prop("checked", area.useDefaultPrompt);
        $(`#psychograph_state_${id}_custom_prompt`).val(area.customPrompt).prop("hidden", area.useDefaultPrompt);
    }

    renderChatState();
}

// Reflects the CURRENT chat's state (target + slots), so this runs both on
// initial load and on CHAT_CHANGED (see bindChatEvents) — otherwise the
// panel would keep showing whatever chat was open when the extension
// first loaded.
function renderChatState() {
    const chatState = ensureChatState();
    $("#psychograph_state_target").val(chatState.target);

    for (const { key, id } of STATE_AREAS) {
        const slots = chatState.areas[key].slots;
        for (const slot of AREA_SLOT_CONFIGS[key].slots) {
            $(`#psychograph_state_${id}_slot_${slot}`).val(slots[slot]);
        }
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
        ensureChatState().target = String($(this).val());
        getContext().saveMetadataDebounced();
    });

    for (const { key, id } of STATE_AREAS) {
        $(`#psychograph_state_${id}_enabled`).on("change", function () {
            ensureSettings().state.areas[key].enabled = $(this).prop("checked");
            saveSettingsDebounced();
        });

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

        for (const slot of AREA_SLOT_CONFIGS[key].slots) {
            $(`#psychograph_state_${id}_slot_${slot}`).on("input", function () {
                ensureChatState().areas[key].slots[slot] = String($(this).val());
                getContext().saveMetadataDebounced();
            });
        }
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

async function runAreaGate(profileId, eligibleAreaKeys, message) {
    if (eligibleAreaKeys.length === 0) {
        return [];
    }

    const prompt = buildAreaGatePrompt(eligibleAreaKeys, message);
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

async function runAreaExtraction(areaKey, message) {
    const settings = ensureSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) {
        console.warn(`[Psychograph] ${areaKey} extraction: no connection profile configured, skipping.`);
        return;
    }

    const config = AREA_SLOT_CONFIGS[areaKey];
    const areaSettings = settings.state.areas[areaKey];
    const area = ensureChatState().areas[areaKey];
    const diffPrompt = areaSettings.useDefaultPrompt
        ? buildAreaDiffPrompt(config, message)
        : areaSettings.customPrompt.replaceAll("{{message}}", message);
    const diffSchema = buildAreaDiffSchema(config);

    let diff;
    try {
        diff = await sendJsonSchemaRequest(profileId, `${areaKey}_diff`, diffSchema, diffPrompt, AREA_DIFF_MAX_TOKENS);
        console.log(`[Psychograph] ${config.label} diff reasoning:`, diff.reasoning);
    } catch (error) {
        console.error(`[Psychograph] ${config.label} diff call failed:`, error);
        return;
    }

    const changedSlots = expandTriggeredSlots(config, config.slots.filter((slot) => diff[slot] === true));
    if (changedSlots.length === 0) {
        return;
    }

    const slotUpdateSchema = buildAreaSlotUpdateSchema(config);
    await Promise.all(changedSlots.map(async (slot) => {
        const currentState = area.slots[slot] || config.slotDefaultSentinel(slot);
        const updatePrompt = buildAreaSlotUpdatePrompt(config, slot, currentState, message);

        try {
            const update = await sendJsonSchemaRequest(
                profileId,
                `${areaKey}_slot_update`,
                slotUpdateSchema,
                updatePrompt,
                AREA_SLOT_UPDATE_MAX_TOKENS,
            );
            console.log(`[Psychograph] ${config.label} update reasoning for "${slot}":`, update.reasoning);
            const value = normalizeSlotValue(config, update.state);
            area.slots[slot] = value;
            $(`#psychograph_state_${config.id}_slot_${slot}`).val(value);
        } catch (error) {
            console.error(`[Psychograph] ${config.label} update call failed for slot "${slot}":`, error);
        }
    }));

    getContext().saveMetadataDebounced();
}

const STATE_INJECT_ID = "psychograph_state";
const STATE_INJECT_HEADING = "## Current state information";

function readTargetName() {
    const context = getContext();
    return (ensureChatState().target === "user" ? context.name1 : context.name2) || "The character";
}

// "|" ends a slash command, so a slot value carrying one would truncate the
// inject and run whatever followed as a command of its own.
function sanitizeSlotValue(value) {
    return String(value).replace(/[|\r\n]+/g, " ").trim();
}

function buildStateSnapshot() {
    const settings = ensureSettings();
    const chatState = ensureChatState();
    const groups = [];

    for (const { key } of STATE_AREAS) {
        if (!settings.state.areas[key].enabled) {
            continue;
        }

        const config = AREA_SLOT_CONFIGS[key];
        const lines = config.slots
            .map((slot) => [slot, sanitizeSlotValue(chatState.areas[key].slots[slot] ?? "")])
            .filter(([, value]) => value)
            .map(([slot, value]) => `- ${slot}: ${value}`);
        if (lines.length === 0) {
            continue;
        }

        const heading = config.scope === "character"
            ? `${readTargetName()}'s ${config.label.toLowerCase()}`
            : config.label;
        groups.push(`${heading}\n${lines.join("\n")}`);
    }

    return groups.join("\n\n");
}

// Runs on GENERATION_AFTER_COMMANDS (covers swipe/continue/regenerate, where no
// MESSAGE_SENT fires) and again after each message's extraction, so the snapshot
// reflects the message that just triggered this turn rather than the one before.
async function refreshStateInject() {
    if (!ensureSettings().enabled) {
        return;
    }

    const snapshot = buildStateSnapshot();
    if (!snapshot) {
        await flushStateInject();
        return;
    }

    await getContext().executeSlashCommandsWithOptions(
        `/inject id=${STATE_INJECT_ID} position=after ephemeral=true scan=true ${STATE_INJECT_HEADING}\n${snapshot} |`,
    );
}

async function handleStateInjectForGeneration(type, _options, dryRun) {
    if (dryRun || type === "quiet") {
        return;
    }
    await refreshStateInject();
}

async function flushStateInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${STATE_INJECT_ID} |`);
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
            // scope: ["session", "graph"] was tried to also surface messages
            // not yet bridged into the graph, but session-scope entries
            // bypass system_prompt below and blew up recall into raw prose.
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

// Hooked on GENERATION_AFTER_COMMANDS (awaited by SillyTavern) so this
// network round trip lands in the same turn rather than the next one.
let cogneeRecallInFlight = false;

async function handleCogneeRecall(type, _options, dryRun) {
    const settings = ensureSettings();
    if (dryRun || type === "quiet" || !settings.enabled || !settings.cognee.recallEnabled || !settings.cognee.baseUrl || !settings.cognee.apiKey) {
        return;
    }
    if (cogneeRecallInFlight) {
        console.warn("[Psychograph] Cognee recall already in progress, skipping this trigger.");
        return;
    }
    cogneeRecallInFlight = true;

    // Not calling context.deactivateSendButtons()/activateSendButtons() here
    // (tried it, reverted): activateSendButtons() emits GENERATION_ENDED if
    // the stop button is visible, which wipes the ephemeral inject this
    // function just set before Generate() reaches prompt assembly.
    const context = getContext();
    $("#send_textarea").prop("disabled", true);

    try {
        const chatCogneeId = getCogneeChatId();
        const recalled = await recallFromCognee(chatCogneeId);
        if (!recalled) {
            return;
        }

        const injectedText = `${COGNEE_RECALL_HEADING}\n${recalled}`;
        console.log("[Psychograph] Cognee recall for next turn:", injectedText);
        toastr.info(injectedText, "Psychograph: Cognee recall", { timeOut: 8000 });

        // position=after (not position=chat): position=chat splices into the
        // chat-history array, which never reaches the context/story-string
        // template that's actually inspected as "the final prompt".
        await context.executeSlashCommandsWithOptions(
            `/inject id=${COGNEE_RECALL_INJECT_ID} position=after ephemeral=true scan=true ${injectedText} |`,
        );
    } catch (error) {
        console.error("[Psychograph] Cognee recall failed:", error);
    } finally {
        cogneeRecallInFlight = false;
        $("#send_textarea").prop("disabled", false);
    }
}

async function flushCogneeRecallInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${COGNEE_RECALL_INJECT_ID} |`);
}

function isAreaTriggerRelevant(areaKey, eventType) {
    const config = AREA_SLOT_CONFIGS[areaKey];
    if (config.triggerMode === "always") {
        return eventType === event_types.MESSAGE_SENT
            || eventType === event_types.MESSAGE_RECEIVED;
    }

    const target = ensureChatState().target;
    if (target === "char") {
        return eventType === event_types.MESSAGE_RECEIVED;
    }
    return eventType === event_types.MESSAGE_SENT;
}

function handleChatMessageEvent(eventType) {
    return async function () {
        const settings = ensureSettings();
        if (!settings.enabled) {
            return;
        }

        const eligibleAreaKeys = Object.keys(AREA_SLOT_CONFIGS).filter((key) =>
            settings.state.areas[key].enabled && isAreaTriggerRelevant(key, eventType));
        if (eligibleAreaKeys.length === 0) {
            return;
        }

        const profileId = settings.connectionProfile;
        if (!profileId) {
            console.warn("[Psychograph] Area gate: no connection profile configured, skipping.");
            return;
        }

        const chat = getContext().chat;
        const lastMessage = chat[chat.length - 1];
        if (!lastMessage) {
            return;
        }

        const gatedAreaKeys = await runAreaGate(profileId, eligibleAreaKeys, lastMessage.mes);
        await Promise.all(gatedAreaKeys.map((areaKey) => runAreaExtraction(areaKey, lastMessage.mes)));
        await refreshStateInject();
    };
}

function bindChatEvents() {
    eventSource.on(event_types.MESSAGE_SENT, handleChatMessageEvent(event_types.MESSAGE_SENT));
    eventSource.on(event_types.MESSAGE_RECEIVED, handleChatMessageEvent(event_types.MESSAGE_RECEIVED));

    // Not bound on MESSAGE_SWIPED: it fires before a new swipe's text is
    // generated, while chat[].mes still holds the previous swipe's content.
    // MESSAGE_RECEIVED (type "swipe") already covers a finished swipe.
    eventSource.on(event_types.MESSAGE_SENT, handleCogneeIngestion);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleCogneeIngestion);

    eventSource.on(event_types.CHAT_CHANGED, renderCogneeChatSection);

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, handleCogneeRecall);
    eventSource.on(event_types.GENERATION_ENDED, flushCogneeRecallInject);

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, handleStateInjectForGeneration);
    eventSource.on(event_types.GENERATION_ENDED, flushStateInject);

    // Slot inputs show the current chat's state — without this they'd keep
    // displaying whatever chat was open when the panel was last rendered.
    eventSource.on(event_types.CHAT_CHANGED, renderChatState);
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

async function rerunAreaExtractionNow(areaKey) {
    const chat = getContext().chat;
    const lastMessage = chat[chat.length - 1];
    if (!lastMessage) {
        toastr.warning("No messages in this chat yet.", "Psychograph");
        return;
    }

    const config = AREA_SLOT_CONFIGS[areaKey];
    toastr.info(`Analyzing ${config.label.toLowerCase()} for the last message…`, "Psychograph");
    await runAreaExtraction(areaKey, lastMessage.mes);
}

async function initAreaFromDescription(areaKey) {
    const config = AREA_SLOT_CONFIGS[areaKey];
    const context = getContext();
    const fields = context.getCharacterCardFields();

    let seedText;
    let missingLabel;
    if (config.seedField === "scenario") {
        seedText = fields.scenario;
        missingLabel = "No scenario found.";
    } else {
        const target = ensureChatState().target;
        seedText = target === "user" ? fields.persona : fields.description;
        missingLabel = target === "user" ? "No persona description found." : "No character description found.";
    }

    if (!seedText || !seedText.trim()) {
        toastr.warning(missingLabel, "Psychograph");
        return;
    }

    toastr.info(`Initializing ${config.label.toLowerCase()} from description…`, "Psychograph");
    await runAreaExtraction(areaKey, seedText);
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

function buildAreaSubmenuHtml() {
    return STATE_AREAS.map(({ key }) => {
        const config = AREA_SLOT_CONFIGS[key];
        return `
            <div class="psychograph-menu-divider">${config.label}</div>
            <div id="psychograph_action_init_${config.id}" class="list-group-item">
                <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div>
                <span>Init ${config.label}</span>
            </div>
            <div id="psychograph_action_${config.id}" class="list-group-item">
                <div class="fa-solid ${config.icon} extensionsMenuExtensionButton"></div>
                <span>${config.label}</span>
            </div>
        `;
    }).join("");
}

function bindAreaSubmenuEvents() {
    for (const { key } of STATE_AREAS) {
        const config = AREA_SLOT_CONFIGS[key];

        $(`#psychograph_action_${config.id}`).on("click", async function () {
            $("#psychograph_submenu").removeClass("shown");
            await rerunAreaExtractionNow(key);
        });

        $(`#psychograph_action_init_${config.id}`).on("click", async function () {
            $("#psychograph_submenu").removeClass("shown");
            await initAreaFromDescription(key);
        });
    }
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
            ${buildAreaSubmenuHtml()}
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

    bindAreaSubmenuEvents();
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
