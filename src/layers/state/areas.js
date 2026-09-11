import { getContext } from "../../sillytavern.js";
import { readTargetProfileText } from "../../chat-state.js";

export const STATE_AREAS = [
    { key: "clothes", id: "clothes" },
    { key: "physicalState", id: "physical_state" },
    { key: "situational", id: "situational" },
];

const CLOTHING_SLOTS = ["top", "bottom", "underwear", "legwear", "footwear", "accessories", "hair", "makeup"];

const PHYSICAL_STATE_SLOTS = ["condition", "constraint", "bodyChanges"];

const SITUATIONAL_SLOTS = ["location", "presentPeople", "timeOfDay"];

export const AREA_DIFF_MAX_TOKENS = 250;

export const AREA_SLOT_UPDATE_MAX_TOKENS = 200;

export const AREA_GATE_MAX_TOKENS = 200;

// Values a model reaches for when a slot holds nothing. Outside Clothes these
// are an absence and must not reach the prompt; inside Clothes "none" is itself
// the information (a bare slot is what the scene is about), see emptyValue.
export const EMPTY_SLOT_ANSWERS = new Set(["none", "nothing", "n/a", "na", "unknown", "not established", "-", "keine", "nichts"]);

// Per-area config for the generic gate -> diff -> per-slot-update pipeline.
// Every call renders the same markdown document (see buildPromptDocument):
// what the job is, what this call is assigned to, the rules, then the message
// last with its speaker on the line above it. The Clothes update wording is
// the variant that tested 10/10 against the user's own model, with the sheet
// named "Clothes" rather than "Clothing" as it was in that run; per CLAUDE.md
// none of this text changes without sign-off and a fresh test run.
export const AREA_SLOT_CONFIGS = {
    clothes: {
        scope: "character",
        id: "clothes",
        label: "Clothes",
        icon: "fa-shirt",
        slots: CLOTHING_SLOTS,
        slotPlaceholders: Object.fromEntries(CLOTHING_SLOTS.map((slot) => [slot, "none"])),
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
        slotPlaceholders: {
            condition: "injury, illness, exhaustion, hunger, intoxication",
            constraint: "what limits their freedom to act",
            bodyChanges: "lasting differences from the profile description",
        },
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
        slotPlaceholders: {
            location: "where they are, and how private or exposed",
            presentPeople: "who is in the scene",
            timeOfDay: "not established",
        },
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

// Slot *values* belong to the conversation, not the user profile — they
// live in chat_metadata (see ensureChatState() below), not in
// extension_settings. Only the configuration above (enabled, prompts,
// connection) is a global preference that should apply across every chat.
// This mirrors how SillyTavern's own Author's Note feature splits its data:
// global defaults in extension_settings, the actual per-conversation values
// namespaced under chat_metadata[extensionName] (public/scripts/authors-note.js).
export const DEFAULT_AREA_SLOTS = Object.fromEntries(
    STATE_AREAS.map(({ key }) => [key, Object.fromEntries(AREA_SLOT_CONFIGS[key].slots.map((slot) => [slot, ""]))]),
);
