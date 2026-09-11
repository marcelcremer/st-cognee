import { getContext } from "./sillytavern.js";
import { extensionName } from "./constants.js";
import { KNOWLEDGE_KEYS } from "./layers/knowledge/layers.js";
import { AREA_SLOT_CONFIGS, DEFAULT_AREA_SLOTS, EMPTY_SLOT_ANSWERS, STATE_AREAS } from "./layers/state/areas.js";

// bodyChanges stores a delta against the character profile, so the profile has
// to be in the update call - the full card, deliberately, since a trimmed
// summary would decide for the model what counts as a physical detail.
export function readTargetProfileText() {
    const fields = getContext().getCharacterCardFields();
    return (ensureChatState().target === "user" ? fields.persona : fields.description) || "";
}

// Which side of the conversation "Applies to" tracks — char or user —
// varies by chat/scenario (sometimes the game drives the user, sometimes
// the user drives the game), so it belongs in chat_metadata alongside the
// slot values, not in the global settings.
const DEFAULT_TARGET = "char";

// Per-chat slot state, namespaced under chat_metadata[extensionName] so it
// travels with the chat file (saved/loaded/exported with the chat) instead
// of leaking between conversations. Always call getContext() fresh here —
// chat_metadata is reassigned wholesale on chat switch/reset, so a cached
// reference would silently point at a stale, orphaned object.
export function ensureChatState() {
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
    chatState.motivation = chatState.motivation || {};
    chatState.motivation.driver = chatState.motivation.driver || "";
    chatState.motivation.continuation = chatState.motivation.continuation || "";
    chatState.motivation.locked = Boolean(chatState.motivation.locked);
    chatState.knowledge = chatState.knowledge || {};
    for (const key of KNOWLEDGE_KEYS) {
        // Chats written before the other two layers existed carry the trigger
        // list under its own key; this is the only copy of it.
        const legacy = key === "triggers" ? chatState.triggerMap : null;
        chatState.knowledge[key] = chatState.knowledge[key] || legacy || {};
        chatState.knowledge[key].entries = chatState.knowledge[key].entries || [];
        delete chatState.knowledge[key].sinceCompaction;
        if (chatState.knowledge[key].seeded === undefined) {
            chatState.knowledge[key].seeded = chatState.knowledge[key].entries.length > 0;
        }
    }
    delete chatState.triggerMap;

    return chatState;
}

// A chat switch reassigns chat_metadata wholesale, so the identity of the
// per-chat state object is what tells an in-flight extraction that the chat it
// started on is gone and its result must be dropped.
export function isCurrentChatState(chatState) {
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

export function readTargetName() {
    const context = getContext();
    return (ensureChatState().target === "user" ? context.name1 : context.name2) || "The character";
}
