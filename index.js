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

// Reading a static profile is a different job from finding a delta in a story
// beat, so every prompt builder takes the mode and picks its own wording.
const MESSAGE_MODE = "message";
const SEED_MODE = "seed";

const AREA_DIFF_MAX_TOKENS = 250;
const AREA_SLOT_UPDATE_MAX_TOKENS = 200;
const AREA_GATE_MAX_TOKENS = 200;
const TIMELINE_ENTRY_MAX_TOKENS = 300;

// Values a model reaches for when a slot holds nothing. Outside Clothes these
// are an absence and must not reach the prompt; inside Clothes "none" is itself
// the information (a bare slot is what the scene is about), see emptyValue.
const EMPTY_SLOT_ANSWERS = new Set(["none", "nothing", "n/a", "na", "unknown", "not established", "-", "keine", "nichts"]);

// Per-area config for the generic gate -> diff -> per-slot-update pipeline.
// Every call renders the same markdown document (see buildPromptDocument):
// what the job is, what this call is assigned to, the rules, then the message
// last with its speaker on the line above it. The Clothes update wording is
// the variant that tested 10/10 against the user's own model, with the sheet
// named "Clothes" rather than "Clothing" as it was in that run; per CLAUDE.md
// none of this text changes without sign-off and a fresh test run.
const AREA_SLOT_CONFIGS = {
    clothes: {
        scope: "character",
        id: "clothes",
        label: "Clothes",
        icon: "fa-shirt",
        slots: CLOTHING_SLOTS,
        seedField: "target",
        groupDescription: "Clothes slots describe, where something is worn and not necessarily a category.",
        diffRules: [
            "Analyze ONLY the message below, not prior context.",
            "For each slot, determine whether the message contains any information about it.",
            "If you find any change for a slot, mark it true. When there is no change about the slot, mark it false.",
        ],
        seedDiffRules: [
            "Analyze ONLY the profile below.",
            "For each slot, determine whether the profile describes what the character wears there.",
            "If the profile describes a slot, mark it true. If it says nothing about the slot, mark it false.",
        ],
        updateRules: [
            "If a new item is added as a layer (e.g. a coat over a blouse), keep the existing item(s) and add the new one.",
            `If a new item explicitly replaces the existing one (e.g. "changes into a dress"), output only the new item(s).`,
            `If the message describes a state/condition change to an existing item (stain, tear, wetness, damage), keep the item and add a short state tag in parentheses (max ~5 words), e.g. "white blouse (coffee stain)".`,
            `If an item is explicitly removed and nothing replaces it, output "none".`,
            "If nothing actually changed despite the trigger, return the state unchanged.",
            "Do not invent details that were not stated in the message.",
            "If an item from the current state is not mentioned in the message at all, keep it unchanged in the output — do not drop it just because it wasn't referenced again.",
        ],
        seedUpdateRules: [
            "Output what the profile describes the character as wearing in this slot.",
            `Use "none" if the profile says nothing about this slot.`,
            "Do not invent details that were not stated in the profile.",
        ],
        hints: [
            "Legwear covers the leg above the ankle, Footwear the foot.",
            "an accessory typically refers to an item worn to complement or enhance a garment or appearance",
        ],
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
        seedDiffReasoningDescription: "One short clause per clothing category (top, bottom, underwear, legwear, footwear, accessories, hair, makeup, in that order), noting whether the profile describes it and why.",
        seedSlotDescriptions: {
            top: "True if the profile describes what the character wears on the upper body (shirts, jackets, coats, etc.).",
            bottom: "True if the profile describes pants, skirts, shorts, or a dress's lower half.",
            underwear: "True if the profile describes underwear.",
            legwear: "True if the profile describes stockings, tights, socks, or garters.",
            footwear: "True if the profile describes shoes, boots, or heels.",
            accessories: "True if the profile describes jewelry, glasses, hats, belts, or similar.",
            hair: "True if the profile describes the character's hairstyle.",
            makeup: "True if the profile describes the character's makeup.",
        },
        slotUpdateStateDescription: "The full new state of this slot after applying the message. Comma-separated list of items if multiple. Use \"none\" if nothing is worn in this slot.",
        seedSlotUpdateStateDescription: "What the profile describes the character as wearing in this slot. Comma-separated list of items if multiple. Use \"none\" if the profile says nothing about this slot.",
        slotDefaultSentinel: () => "none",
        gateDescription: "True if the message contains information about what a character is wearing, or a change to it.",
        gateSummary: "what a character is wearing, or a change to it.",
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
        seedField: "target",
        emptyValue: "",
        groupDescription: "Body slots track the character's body and what currently limits their ability to act.",
        diffRules: [
            "For each slot, determine whether the message contains any information about it.",
            "If you find any information for a slot, mark it true. Otherwise mark it false.",
        ],
        seedDiffRules: [
            "For each slot, determine whether the profile describes it.",
            "If the profile describes a slot, mark it true. Otherwise mark it false.",
        ],
        updateRules: [
            "If the message adds new information, incorporate it into the existing state.",
            `If the message explicitly resolves or ends what the slot describes, output "none".`,
            "If nothing actually changed despite the trigger, return the state unchanged.",
            "Do not invent details that were not stated in the message.",
        ],
        seedUpdateRules: [
            "Output what the profile states for this slot.",
            `Output "none" if the profile says nothing about this slot.`,
            "Do not invent details that were not stated in the profile.",
        ],
        seedDiffReasoningDescription: "One short clause per slot (condition, constraint, in that order), noting whether the profile describes it and why.",
        seedSlotDescriptions: {
            condition: "True if the profile describes a bodily state the character is in — injury, illness, exhaustion, hunger, or intoxication.",
            constraint: "True if the profile describes what limits the character's freedom to act — being restrained, confined, guarded, or under an obligation they cannot simply walk away from.",
        },
        diffReasoningDescription: "One short clause per slot (condition, constraint, bodyChanges, in that order), noting whether the message contains information about it and why.",
        slotDescriptions: {
            condition: "True if the message contains information about the character's temporary bodily state — injury, illness, exhaustion, hunger, or intoxication.",
            constraint: "True if the message contains information about what currently limits the character's freedom to act — being restrained, confined, guarded, or under an obligation they cannot simply walk away from.",
            bodyChanges: "True if the message establishes a lasting change to the character's body compared to how they are described in their profile, whether deliberate (a tattoo, a piercing) or not (weight, a scar, visible aging).",
        },
        slotOverrides: {
            // Only slot that stores a delta rather than a value, so it is the
            // only one whose update call needs the profile it is a delta against.
            bodyChanges: {
                // Seeding it from the card would fill the slot with the very
                // profile it stores a delta against.
                skipOnSeed: true,
                profileContext: () => readTargetProfileText(),
                updateRules: [
                    "Output ONLY how the body now differs from the profile above. Never repeat anything the profile already says.",
                    `If the message establishes a new lasting change, append it to the existing entries, separated by "; ".`,
                    "Keep existing entries unless the message explicitly reverses one.",
                    "If nothing lasting changed, return the entries unchanged.",
                    `Output "none" if the body does not differ from the profile at all.`,
                ],
            },
        },
        slotUpdateStateDescription: "The new value of this slot after applying the update rules above.",
        seedSlotUpdateStateDescription: "The starting value of this slot as stated in the profile.",
        slotDefaultSentinel: () => "none",
        gateDescription: "True if the message contains information about a character's bodily condition, what limits their freedom to act, or a lasting change to their body.",
        gateSummary: "a character's bodily condition, what limits their freedom to act, or a lasting change to their body.",
    },
    situational: {
        scope: "scene",
        id: "situational",
        label: "Scene",
        icon: "fa-location-dot",
        slots: SITUATIONAL_SLOTS,
        seedField: "scenario",
        emptyValue: "",
        groupDescription: "Scene slots describe the scene the characters are currently in - where they are, who is with them, and when it is - not their actions or dialogue.",
        diffRules: [
            "For each slot, determine whether the message contains any information about it.",
            "If you find any information for a slot, mark it true. Otherwise mark it false.",
        ],
        seedDiffRules: [
            "For each slot, determine whether the scenario describes it.",
            "If the scenario describes a slot, mark it true. Otherwise mark it false.",
        ],
        updateRules: [
            "If the message establishes new information, incorporate it into the state.",
            "If the message explicitly changes this aspect of the scene, replace the state with the new value.",
            "If nothing actually changed despite the trigger, return the state unchanged.",
            "Do not invent or infer details that were not explicitly stated.",
        ],
        seedUpdateRules: [
            "Output what the scenario establishes for this slot.",
            `Output "none" if the scenario says nothing about this slot.`,
            "Do not invent or infer details that were not explicitly stated.",
        ],
        seedDiffReasoningDescription: "One short clause per slot (location, presentPeople, timeOfDay, in that order), noting whether the scenario describes it and why.",
        seedSlotDescriptions: {
            location: "True if the scenario states where the characters are.",
            presentPeople: "True if the scenario names who is present.",
            timeOfDay: "True if the scenario states or unambiguously implies the time of day.",
        },
        diffReasoningDescription: "One short clause per slot (location, presentPeople, timeOfDay, in that order), noting whether the message contains information about it and why.",
        slotDescriptions: {
            location: "True if the message states or changes where the characters are, or how private, exposed, or safe that place is.",
            presentPeople: "True if the message states that someone is present in the scene, arrives, or leaves.",
            timeOfDay: "True if the message explicitly states or unambiguously implies the time of day.",
        },
        slotOverrides: {
            presentPeople: {
                updateRules: [
                    "Write out the full list of everyone present after applying the message.",
                    "Keep everyone who was already present unless the message says they left.",
                    "Add anyone the message says arrived or is present.",
                    `Separate names with ", ".`,
                    "Do not invent people who were not named.",
                ],
                seedUpdateRules: [
                    "List everyone the scenario says is present.",
                    `Separate names with ", ".`,
                    "Do not invent people who were not named.",
                ],
            },
        },
        // A scene cut ("she drove home") changes the cast without naming anyone,
        // so the location trigger has to pull presentPeople along or the old cast
        // stays in the list forever.
        slotTriggers: { location: ["presentPeople"] },
        slotUpdateStateDescription: "The new value of this slot after applying the update rules above.",
        seedSlotUpdateStateDescription: "The starting value of this slot as established by the scenario.",
        slotDefaultSentinel: (slot) => {
            if (slot !== "presentPeople") return "none";
            const context = getContext();
            return [context.name1, context.name2].filter(Boolean).join(", ") || "none";
        },
        gateDescription: "True if the message contains information about where the characters are, who is with them, or what time it is.",
        gateSummary: "where the characters are, who is with them, or what time it is.",
    },
};

// bodyChanges stores a delta against the character profile, so the profile has
// to be in the update call - the full card, deliberately, since a trimmed
// summary would decide for the model what counts as a physical detail.
function readTargetProfileText() {
    const fields = getContext().getCharacterCardFields();
    return (ensureChatState().target === "user" ? fields.persona : fields.description) || "";
}

// The message goes last, after the rules, with its speaker on the line above
// it - the model reads the whole assignment before it ever sees the text it
// has to apply the assignment to.
function buildPromptDocument(sections, speaker, message) {
    const body = sections
        .filter((section) => section && section.content)
        .map((section) => `${section.heading}\n${section.content}`)
        .join("\n\n");
    return `${body}\n---\n${speaker ? `${speaker}\n` : ""}${message}`;
}

function bulletList(items) {
    return items.filter(Boolean).map((item) => `- ${item}`).join("\n");
}

function qualifiedSlotName(config, slot) {
    return `"${config.label} / ${slot}"`;
}

// Naming the sheet's owner is what tells the model whose state it is filling
// in: with two people in a scene "she" is otherwise a guess, and extraction
// runs on every message regardless of who wrote it.
function buildSheetIntro(config, focusPhrase, mode) {
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

function buildAttributionRule(config) {
    if (config.scope !== "character") {
        return null;
    }
    const target = readTargetName();
    return `Only information about ${target} counts - information about anyone else does not.`;
}

function buildHintSection(config) {
    return {
        heading: "## Additional hints",
        content: bulletList([
            ...(config.hints ?? []),
            "Reasoning is just for debug, so one concise sentence is enough.",
        ]),
    };
}

function buildAreaDiffPrompt(config, slots, message, speaker, mode) {
    const exampleShape = JSON.stringify({
        reasoning: "...",
        ...Object.fromEntries(slots.map((slot) => [slot, false])),
    });
    const countPhrase = slots.length === 1 ? "the boolean" : `the ${slots.length} booleans`;

    return buildPromptDocument([
        { heading: "# Task Description", content: buildSheetIntro(config, "one specific group of slots", mode) },
        {
            heading: "## Slots",
            content: `Your current task is to work on the following slots: ${slots.map((slot) => qualifiedSlotName(config, slot)).join(", ")}.`,
        },
        { heading: "## Slot description", content: config.groupDescription },
        {
            heading: "## Rules",
            content: bulletList([
                ...(mode === SEED_MODE ? config.seedDiffRules : config.diffRules),
                buildAttributionRule(config),
                "There are multiple groups of slots on the sheet. You MUST only concentrate only on your assigned group.",
            ]),
        },
        buildHintSection(config),
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence). Fill in\n"reasoning" first, then ${countPhrase}, using exactly this shape:\n${exampleShape}`,
        },
    ], speaker, message);
}

function buildAreaDiffSchema(config, slots, mode) {
    const seeding = mode === SEED_MODE;
    const slotDescriptions = seeding ? config.seedSlotDescriptions : config.slotDescriptions;
    const properties = {
        reasoning: {
            type: "string",
            description: seeding ? config.seedDiffReasoningDescription : config.diffReasoningDescription,
        },
    };
    for (const slot of slots) {
        properties[slot] = { type: "boolean", description: slotDescriptions[slot] };
    }
    return {
        type: "object",
        properties,
        required: ["reasoning", ...slots],
        additionalProperties: false,
    };
}

function buildAreaSlotUpdatePrompt(config, slot, currentState, message, speaker, mode) {
    const overrides = config.slotOverrides?.[slot] ?? {};
    const seeding = mode === SEED_MODE;

    return buildPromptDocument([
        { heading: "# Task Description", content: buildSheetIntro(config, "one specific slot", mode) },
        { heading: "## Slot", content: `Your current task is to work on the following slot: ${qualifiedSlotName(config, slot)}.` },
        { heading: "## Slot description", content: config.groupDescription },
        overrides.profileContext
            ? { heading: "## Character profile", content: `"""\n${overrides.profileContext()}\n"""` }
            : null,
        // A seed run establishes the starting value, so whatever is in the slot
        // is what it replaces - showing it would only invite the model to keep it.
        seeding ? null : {
            heading: "## Current state",
            content: `The Current state of the slot ${qualifiedSlotName(config, slot)} is: "${currentState}"`,
        },
        {
            heading: "## Rules",
            content: bulletList([
                ...(seeding
                    ? (overrides.seedUpdateRules ?? config.seedUpdateRules)
                    : (overrides.updateRules ?? config.updateRules)),
                buildAttributionRule(config),
                "There are multiple slots on the sheet. You MUST only concentrate only on your assigned slot.",
            ]),
        },
        buildHintSection(config),
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence). Fill in\n"reasoning" first, then "state", using exactly this shape:\n{"reasoning": "...", "state": "..."}.`,
        },
    ], speaker, message);
}

function buildAreaSlotUpdateSchema(config, mode) {
    return {
        type: "object",
        properties: {
            reasoning: {
                type: "string",
                description: "One short sentence working through which of the update rules below applies, before answering.",
            },
            state: {
                type: "string",
                description: mode === SEED_MODE ? config.seedSlotUpdateStateDescription : config.slotUpdateStateDescription,
            },
        },
        required: ["reasoning", "state"],
        additionalProperties: false,
    };
}

// No tracked character here: the gate only decides whether a turn touches an
// area at all, never what the value would be, so naming an owner would pull it
// into an extraction it is not doing - and Scene has no owner to name.
function buildAreaGatePrompt(eligibleAreaKeys, message, speaker) {
    const exampleShape = JSON.stringify({
        reasoning: "...",
        ...Object.fromEntries(eligibleAreaKeys.map((key) => [key, false])),
    });
    const countPhrase = eligibleAreaKeys.length === 1 ? "the boolean" : `the ${eligibleAreaKeys.length} booleans`;

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "Your Job is to decide which parts of a roleplay sheet a message is relevant to. The sheet is grouped into areas, and you only decide whether an area is affected at all, never how.",
        },
        {
            heading: "## Areas",
            content: bulletList(eligibleAreaKeys.map((key) => {
                const config = AREA_SLOT_CONFIGS[key];
                return `"${config.label}": ${config.gateSummary}`;
            })),
        },
        {
            heading: "## Rules",
            content: bulletList([
                "If you find any information relevant to an area, mark it true. Otherwise mark it false.",
                "You MUST NOT extract any values. Deciding relevance is the whole task.",
            ]),
        },
        { heading: "## Additional hints", content: bulletList(["Reasoning is just for debug, so one concise sentence is enough."]) },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence). Fill in\n"reasoning" first, then ${countPhrase}, using exactly this shape:\n${exampleShape}`,
        },
    ], speaker, message);
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

// Shown in place of the entry list while the timeline is still empty: an empty
// section would be dropped from the document entirely, leaving the model
// without the heading the rules below refer back to.
const TIMELINE_EMPTY_PLACEHOLDER = "Nothing yet.";

// Under evaluation against the user's own model — see CLAUDE.md before
// touching any of this wording.
function buildTimelinePrompt(currentTimeline, speaker, message) {
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

function buildTimelineSchema() {
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
        areas: Object.fromEntries(STATE_AREAS.map(({ key }) => [key, { enabled: true }])),
    },
    timeline: {
        includeHidden: true,
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

// A /sys note or a hidden message is not story text: it must neither move
// slot state nor reach the graph.
function isStoryMessage(message) {
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
function isTimelineMessage(message, includeHidden) {
    if (!message || !String(message.mes ?? "").trim() || isChatUiMessage(message)) {
        return false;
    }
    return includeHidden || !message.is_system;
}

const STATE_EXTRACTED_KEY = "psychographStateExtracted";

// The marker lives in message.extra, not in an in-memory set, so it survives a
// reload. saveMetadataDebounced() is what persists it: chat metadata is stored
// inside the chat file, so writing it writes the messages along with it.
function isStateExtracted(message) {
    return Boolean(message?.extra?.[STATE_EXTRACTED_KEY]);
}

function markStateExtracted(message) {
    message.extra = message.extra || {};
    message.extra[STATE_EXTRACTED_KEY] = true;
    getContext().saveMetadataDebounced();
}

function ensureSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    settings.cognee = Object.assign(structuredClone(defaultSettings.cognee), settings.cognee);
    settings.timeline = Object.assign(structuredClone(defaultSettings.timeline), settings.timeline);
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
    migrateCogneeChatId(chatState);
    for (const { key } of STATE_AREAS) {
        const stored = chatState.areas[key]?.slots ?? {};
        chatState.areas[key] = {
            slots: Object.fromEntries(
                AREA_SLOT_CONFIGS[key].slots.map((slot) => [slot, stored[slot] ?? DEFAULT_AREA_SLOTS[key][slot]]),
            ),
        };
    }
    if (chatState.seeded === undefined) {
        chatState.seeded = hasExtractedState(chatState);
    }
    if (chatState.timeline === undefined) {
        chatState.timeline = "";
    }

    return chatState;
}

// A chat switch reassigns chat_metadata wholesale, so the identity of the
// per-chat state object is what tells an in-flight extraction that the chat it
// started on is gone and its result must be dropped.
function isCurrentChatState(chatState) {
    return ensureChatState() === chatState;
}

const LEGACY_COGNEE_METADATA_KEY = "stPsychograph";

// The Cognee chat id used to live in its own chat_metadata namespace next to
// the one holding the slot state. Chats written before the merge still carry
// it there, and losing it would orphan that chat's Cognee dataset.
function migrateCogneeChatId(chatState) {
    const chatMetadata = getContext().chatMetadata;
    const legacy = chatMetadata[LEGACY_COGNEE_METADATA_KEY];
    if (!legacy) {
        return;
    }

    if (chatState.cogneeChatId === undefined && legacy.cogneeChatId) {
        chatState.cogneeChatId = legacy.cogneeChatId;
    }
    delete chatMetadata[LEGACY_COGNEE_METADATA_KEY];
}

// A chat that already carries extracted state predates the seeded flag, and
// seeding it now would overwrite what the chat itself established.
function hasExtractedState(chatState) {
    return STATE_AREAS.some(({ key }) => AREA_SLOT_CONFIGS[key].slots.some(
        (slot) => chatState.areas[key].slots[slot] !== DEFAULT_AREA_SLOTS[key][slot],
    ));
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
    $("#psychograph_timeline_include_hidden").prop("checked", settings.timeline.includeHidden);
    renderCogneeChatSection();

    for (const { key, id } of STATE_AREAS) {
        $(`#psychograph_state_${id}_enabled`).prop("checked", settings.state.areas[key].enabled);
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
    $("#psychograph_timeline").val(chatState.timeline);

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
        shownConfigWarnings.clear();
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

    $("#psychograph_timeline").on("input", function () {
        ensureChatState().timeline = String($(this).val());
        getContext().saveMetadataDebounced();
    });

    $("#psychograph_timeline_include_hidden").on("change", function () {
        ensureSettings().timeline.includeHidden = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_timeline_build").on("click", buildTimeline);

    $("#psychograph_timeline_clear").on("click", async function () {
        const context = getContext();
        const confirmed = await context.callGenericPopup(
            "Clear this chat's timeline? The entries only exist here.",
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        writeTimeline("");
    });

    $("#psychograph_state_target").on("change", function () {
        ensureChatState().target = String($(this).val());
        getContext().saveMetadataDebounced();
    });

    for (const { key, id } of STATE_AREAS) {
        $(`#psychograph_state_${id}_enabled`).on("change", function () {
            ensureSettings().state.areas[key].enabled = $(this).prop("checked");
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

// Extraction runs on every turn, so a misconfiguration would stack one toast
// per message without this.
const shownConfigWarnings = new Set();

function warnOnce(key, message) {
    if (shownConfigWarnings.has(key)) {
        return;
    }
    shownConfigWarnings.add(key);
    toastr.warning(message, "Psychograph");
}

const NO_PROFILE_WARNING = "No connection profile selected for Psychograph — state extraction stays off until you pick one.";

// The only backends SillyTavern forwards json_schema to; everywhere else
// enforcement silently no-ops, see docs/sillytavern-ui-notes.md.
const SCHEMA_ENFORCING_APIS = new Set(["tabby", "llamacpp"]);

function warnIfSchemaEnforcementUnsupported(profile) {
    const suffix = "Extraction falls back to the prompt alone, which small models follow less reliably.";

    if (profile.mode !== "tc") {
        warnOnce(`schema:${profile.id}`, `"${profile.name}" is a chat-completion profile and SillyTavern doesn't send a JSON schema for those. ${suffix}`);
        return;
    }

    const api = String(profile.api ?? "").toLowerCase();
    if (api && !SCHEMA_ENFORCING_APIS.has(api)) {
        warnOnce(`schema:${profile.id}`, `SillyTavern doesn't forward the JSON schema to ${api}, only to TabbyAPI and llama.cpp. ${suffix}`);
    }
}

function resolveProfile(profileId) {
    let profile = null;
    try {
        profile = ConnectionManagerRequestService.getProfile(profileId);
    } catch (error) {
        console.error("[Psychograph] Connection profile lookup failed:", error);
    }

    if (!profile) {
        warnOnce(`profile:${profileId}`, "The connection profile Psychograph is configured to use no longer exists. Pick one in the Psychograph settings.");
        return null;
    }

    warnIfSchemaEnforcementUnsupported(profile);
    return profile;
}

async function sendJsonSchemaRequest(profileId, schemaName, schema, prompt, maxTokens) {
    const profile = resolveProfile(profileId);
    if (!profile) {
        throw new Error(`Connection profile "${profileId}" is unavailable.`);
    }

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

// Two overlapping runs read the same slot values as their base and write back
// one after the other, so the later run's write silently drops the earlier
// one's change.
let stateExtractionInFlight = false;

async function runExclusiveStateExtraction(task) {
    if (stateExtractionInFlight) {
        console.warn("[Psychograph] State extraction already in progress, skipping this trigger.");
        return false;
    }

    stateExtractionInFlight = true;
    try {
        await task();
    } finally {
        stateExtractionInFlight = false;
    }
    return true;
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

const STATE_INJECT_ID = "psychograph_state";
const STATE_INJECT_HEADING = "## Current state information";

// Whoever wrote a message may be describing someone else, so the speaker is
// an anchor for attribution, never a filter on which messages are read.
function readMessageSpeaker(message) {
    const context = getContext();
    return message?.name || (message?.is_user ? context.name1 : context.name2) || "";
}

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

function readTimeline() {
    return ensureChatState().timeline ?? "";
}

function writeTimeline(text) {
    ensureChatState().timeline = text;
    $("#psychograph_timeline").val(text);
    getContext().saveMetadataDebounced();
}

// The model is asked for a sentence, not for markup, but it sees a bullet list
// in the prompt and sometimes answers in kind.
function normalizeTimelineEntry(entry) {
    return String(entry ?? "").replace(/\s+/g, " ").replace(/^[-*]\s*/, "").trim();
}

function appendTimelineEntry(entry) {
    const existing = readTimeline().trimEnd();
    writeTimeline(existing ? `${existing}\n- ${entry}` : `- ${entry}`);
}

let timelineBuildRunning = false;
let timelineBuildCancelled = false;

// Every message is offered to the model, including ones an earlier build
// already saw: what keeps a rebuild from duplicating entries is the timeline
// itself being in the prompt, not a per-message marker.
async function buildTimeline() {
    if (timelineBuildRunning) {
        timelineBuildCancelled = true;
        return;
    }

    const profileId = ensureSettings().connectionProfile;
    if (!profileId) {
        toastr.warning(NO_PROFILE_WARNING, "Psychograph");
        return;
    }

    const includeHidden = ensureSettings().timeline.includeHidden;
    const messages = getContext().chat.filter((message) => isTimelineMessage(message, includeHidden));
    if (messages.length === 0) {
        toastr.info("No messages in this chat yet.", "Psychograph");
        return;
    }

    const chatState = ensureChatState();
    const schema = buildTimelineSchema();
    timelineBuildRunning = true;
    timelineBuildCancelled = false;
    $("#psychograph_timeline_build").text("Stop");

    let added = 0;
    try {
        for (let i = 0; i < messages.length; i++) {
            if (timelineBuildCancelled) {
                break;
            }
            if (!isCurrentChatState(chatState)) {
                console.warn("[Psychograph] Chat changed during the timeline build, stopping.");
                break;
            }

            const message = messages[i];
            $("#psychograph_timeline_status").text(`Message ${i + 1}/${messages.length}, ${added} entries added…`);

            try {
                const prompt = buildTimelinePrompt(readTimeline(), readMessageSpeaker(message), message.mes);
                const result = await sendJsonSchemaRequest(profileId, "timeline_entry", schema, prompt, TIMELINE_ENTRY_MAX_TOKENS);
                console.log(`[Psychograph] Timeline reasoning for message ${i + 1}:`, result.reasoning);

                const entry = normalizeTimelineEntry(result.entry);
                if (result.significant !== true || !entry) {
                    continue;
                }
                if (!isCurrentChatState(chatState)) {
                    console.warn("[Psychograph] Chat changed during the timeline build, discarding the entry.");
                    break;
                }
                appendTimelineEntry(entry);
                added++;
            } catch (error) {
                console.error(`[Psychograph] Timeline call failed for message ${i + 1}:`, error);
            }
        }

        if (timelineBuildCancelled) {
            toastr.info(`Stopped after ${added} new entries.`, "Psychograph");
        } else {
            toastr.success(`Timeline built, ${added} new entries.`, "Psychograph");
        }
    } finally {
        timelineBuildRunning = false;
        $("#psychograph_timeline_build").text("Build timeline");
        $("#psychograph_timeline_status").text("");
    }
}

// Stored in chat_metadata (saved inside the chat file itself) rather than
// derived from the chat's filename/chatId, so it survives a chat rename —
// this is the id that scopes a Cognee dataset/session to one specific
// roleplay instance, since the same character can have many separate chats.
function readCogneeChatId() {
    return ensureChatState().cogneeChatId;
}

function writeCogneeChatId(id) {
    ensureChatState().cogneeChatId = id;
    getContext().saveMetadataDebounced();
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
    if (!isStoryMessage(predecessor) || cogneeIngestedMessages.has(predecessor)) {
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
    const messages = context.chat.filter(isStoryMessage);
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

function handleChatMessageEvent() {
    return async function () {
        const settings = ensureSettings();
        if (!settings.enabled) {
            return;
        }

        const eligibleAreaKeys = Object.keys(AREA_SLOT_CONFIGS).filter((key) =>
            settings.state.areas[key].enabled);
        if (eligibleAreaKeys.length === 0) {
            return;
        }

        const profileId = settings.connectionProfile;
        if (!profileId) {
            warnOnce("profile:none", NO_PROFILE_WARNING);
            console.warn("[Psychograph] Area gate: no connection profile configured, skipping.");
            return;
        }

        await runExclusiveStateExtraction(async () => {
            if (!ensureChatState().seeded) {
                await seedChatStateFromCard(eligibleAreaKeys);
            }

            const chat = getContext().chat;
            // The newest message is still swipeable, and a swipe re-fires this
            // event with new text — extracting it would apply a second diff on
            // top of state the first run already moved. The predecessor is
            // settled, so it can only ever be extracted once.
            const message = chat[chat.length - 2];
            if (!isStoryMessage(message) || isStateExtracted(message)) {
                return;
            }
            markStateExtracted(message);

            const speaker = readMessageSpeaker(message);
            const gatedAreaKeys = await runAreaGate(profileId, eligibleAreaKeys, message.mes, speaker);
            await Promise.all(gatedAreaKeys.map((areaKey) => runAreaExtraction(areaKey, message.mes, speaker)));
            await refreshStateInject();
        });
    };
}

function bindChatEvents() {
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
    if (!isStoryMessage(lastMessage)) {
        toastr.warning("The last message is a system or hidden message, nothing to analyze.", "Psychograph");
        return;
    }

    const config = AREA_SLOT_CONFIGS[areaKey];
    const ran = await runExclusiveStateExtraction(async () => {
        toastr.info(`Analyzing ${config.label.toLowerCase()} for the last message…`, "Psychograph");
        await runAreaExtraction(areaKey, lastMessage.mes, readMessageSpeaker(lastMessage));
    });
    if (!ran) {
        toastr.warning("Another extraction is still running, try again in a moment.", "Psychograph");
    }
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

async function initAreaFromDescription(areaKey) {
    const config = AREA_SLOT_CONFIGS[areaKey];
    const { text, missingLabel } = readAreaSeedText(config);

    if (!text || !text.trim()) {
        toastr.warning(missingLabel, "Psychograph");
        return;
    }

    const ran = await runExclusiveStateExtraction(async () => {
        toastr.info(`Initializing ${config.label.toLowerCase()} from description…`, "Psychograph");
        ensureChatState().seeded = true;
        await runAreaExtraction(areaKey, text, "", SEED_MODE);
        getContext().saveMetadataDebounced();
    });
    if (!ran) {
        toastr.warning("Another extraction is still running, try again in a moment.", "Psychograph");
    }
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
