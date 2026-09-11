import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../events.js";
import { ConnectionManagerRequestService } from "../../shared.js";
import { dragElement } from "../../../RossAscends-mods.js";
import { loadMovingUIState } from "../../../power-user.js";

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
const TIMELINE_KEEP_MAX_TOKENS = 200;

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

// Deliberately context-free: the entry is judged on its own substance, not
// against the timeline it would join. Under evaluation against the user's own
// model — see CLAUDE.md before touching any of this wording.
function buildTimelineKeepPrompt(entry) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "You will see a single candidate timeline entry, with no other context. Your job is to judge whether it's substantial enough to keep on a long-running story timeline, or whether it should be discarded as too minor.",
        },
        {
            heading: "## The test",
            content: "If you were a book summarizer who had to create a timeline of events - would you include this summary in your timeline or discard it?",
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:\n{"reasoning": "...", "keep": true | false}`,
        },
    ], "", entry);
}

function buildTimelineKeepSchema() {
    return {
        type: "object",
        properties: {
            reasoning: {
                type: "string",
                description: "One concise sentence working through the test above, before answering.",
            },
            keep: {
                type: "boolean",
                description: "True if the entry is substantial enough for a long-running story timeline.",
            },
        },
        required: ["reasoning", "keep"],
        additionalProperties: false,
    };
}

// Under evaluation against the user's own model — see CLAUDE.md before
// touching any of this wording.
function buildTriggerMapPrompt(currentMap, speaker, message) {
    const context = getContext();

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `Your job is to check a recent excerpt of the roleplay between ${context.name1} and ${context.name2} for standing trigger-response patterns worth adding to a character's trigger map, and to write them if any exist. You are NOT continuing the roleplay, judging the content, or writing dialogue.`,
        },
        {
            heading: "## The test",
            content: `Imagine you're writing a character bible for a show's writers' room — the reference sheet that lists "whenever X happens, this character reliably does Y," so future episodes stay consistent. Would this excerpt earn an entry on that sheet?

That means the excerpt must state that the pair recurs — with a word like "always", "every time" or "whenever", or as a conditioning that was deliberately established. A reaction the excerpt only shows happening once is not a trigger pattern, however strong that reaction is. A single moment of sadness is not one either. "Whenever she smells smoke, she goes quiet and won't answer" is.

The excerpt may contain zero, one, or several such patterns — check for all of them, across all characters present.

If the excerpt only shows a character reacting to something, and does not say the same reaction happens whenever that condition occurs, there is nothing to log for that character.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip any pattern that reinforces or adds detail to an existing entry above (same trigger, same character) — that pattern is already captured. Only include a pattern if the trigger, the response, or the character is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"trigger" is the condition, as concrete and specific as the excerpt actually supports (e.g. "sees the color red", not "gets upset").`,
                `"response" is what reliably happens — involuntary reactions, behavior changes, emotional shifts. Neutral, present tense, no editorializing about how significant it is.`,
                `If the excerpt states *why* the pattern exists (a trauma, an implanted memory, a past event), include it briefly in "response" only if stated — don't infer a cause that isn't in the text.`,
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "trigger": "...", "response": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], speaker, message);
}

// A profile is not a scene, so the seed gets its own wording rather than the
// message prompt with other text poured into it — the same split the State
// layer makes between its message and seed modes.
function buildTriggerSeedPrompt(name, profile, currentMap) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "Your job is to read a character profile and write down the standing trigger-response patterns it already establishes, so they are on the character's trigger map before the roleplay starts. You are NOT continuing the roleplay, judging the content, or writing dialogue.",
        },
        {
            heading: "## The test",
            content: `Imagine you're writing a character bible for a show's writers' room — the reference sheet that lists "whenever X happens, this character reliably does Y," so every episode stays consistent. Which of those entries does this profile already give you?

That means the profile must state a condition-response pair that holds whenever the condition occurs, or a conditioning that was deliberately established. A trait is not a pattern: "she is nervous around dogs" stays out. "Whenever she hears the word 'sleep', her eyes go glassy and she follows instructions" is one. A single event from the character's past is not one either, unless the profile says it still happens.

The profile may contain zero, one, or several such patterns — check for all of them.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip any pattern that reinforces or adds detail to an existing entry above (same trigger, same character) — that pattern is already captured. Only include a pattern if the trigger, the response, or the character is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"trigger" is the condition, as concrete and specific as the profile actually supports (e.g. "hears the word 'sleep'", not "gets suggestible").`,
                `"response" is what reliably happens — involuntary reactions, behavior changes, emotional shifts. Neutral, present tense, no editorializing about how significant it is.`,
                `If the profile states *why* the pattern exists (a trauma, an implanted memory, a past event), include it briefly in "response" only if stated — don't infer a cause that isn't in the text.`,
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "trigger": "...", "response": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], `Profile of ${name}`, profile);
}

// --- Facts -------------------------------------------------------------
// PROVISIONAL WORDING, not yet tested against the user's model.

function buildFactPrompt(currentMap, speaker, message) {
    const context = getContext();

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `Your job is to check a recent excerpt of the roleplay between ${context.name1} and ${context.name2} for facts worth keeping, and to write them down if any exist. You are NOT continuing the roleplay, judging the content, or writing dialogue.`,
        },
        {
            heading: "## The test",
            content: `A fact is something that would still be true next week no matter what happens in the scene: who someone is related to, who they work for, where they come from, what they own, what they are called.

What someone is doing, feeling, wearing or where they are standing right now is not a fact — that is the current situation and it is tracked elsewhere. Neither is something that merely happened; the event belongs elsewhere, only its lasting result is a fact. "Kim quit the clinic" is an event. "Kim no longer works at the clinic" is a fact.

The excerpt may contain zero, one, or several facts — check for all of them, about anyone mentioned.`,
        },
        {
            heading: "## Already known (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a fact down if it is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `Write it as three parts: "subject", "relation", "object" — for example subject "Jake", relation "is cousin of", object "Kim Bauer".`,
                "The subject is whoever the fact is about, in the direction the excerpt states it.",
                `Keep the relation short and lowercase, in the present tense: "works at", "is cousin of", "lives in".`,
                "Do not infer a fact that the excerpt does not state.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"subject": "...", "relation": "...", "object": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], speaker, message);
}

function buildFactSeedPrompt(name, profile, currentMap) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "Your job is to read a character profile and write down the facts it establishes, so they are known before the roleplay starts. You are NOT continuing the roleplay, judging the content, or writing dialogue.",
        },
        {
            heading: "## The test",
            content: `A fact is something that would still be true next week no matter what happens in the story: who someone is related to, who they work for, where they come from, what they own, what they are called.

What the character is *like* is not a fact — temperament, habits, looks and skills are the profile's own job and stay there. Neither is a single event from their past; only its lasting result is a fact.

The profile may contain zero, one, or several facts — check for all of them, about anyone it mentions.`,
        },
        {
            heading: "## Already known (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a fact down if it is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `Write it as three parts: "subject", "relation", "object" — for example subject "Jake", relation "is cousin of", object "Kim Bauer".`,
                "The subject is whoever the fact is about, in the direction the profile states it.",
                `Keep the relation short and lowercase, in the present tense: "works at", "is cousin of", "lives in".`,
                "Do not infer a fact that the profile does not state.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"subject": "...", "relation": "...", "object": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], `Profile of ${name}`, profile);
}

// --- Dispositions ------------------------------------------------------
// PROVISIONAL WORDING, not yet tested against the user's model.

function buildDispositionPrompt(currentMap, speaker, message) {
    const context = getContext();

    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: `Your job is to check a recent excerpt of the roleplay between ${context.name1} and ${context.name2} for lasting dispositions — what a character has come to feel, believe or expect — and to write them down if any exist. You are NOT continuing the roleplay, judging the content, or writing dialogue.`,
        },
        {
            heading: "## The test",
            content: `A disposition colours how a character behaves from now on, in situations the excerpt does not even mention: what they have stopped trusting, what they want, what they cannot stand, what a person or a subject has come to mean to them.

It is not a compulsion. The character can act against a disposition if they choose to — that is what separates it from an automatic reaction they have no say in.

A passing mood is not a disposition. Being annoyed right now is not one; having come to resent someone is.

The excerpt may contain zero, one, or several — check for all of them, across all characters present.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a disposition down if it is genuinely new, or if the excerpt changes one that is listed.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"disposition" is one short sentence in the present tense, stating what now holds for that character — "has stopped trusting Jacob", "dislikes being called Kimmy".`,
                "If the excerpt states what caused it, include it briefly only if stated — don't infer a cause that isn't in the text.",
                "No editorializing about how significant or surprising it is.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "disposition": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], speaker, message);
}

function buildDispositionSeedPrompt(name, profile, currentMap) {
    return buildPromptDocument([
        {
            heading: "# Task Description",
            content: "Your job is to read a character profile and write down the lasting dispositions it establishes — what the character feels, believes or expects going into the story. You are NOT continuing the roleplay, judging the content, or writing dialogue.",
        },
        {
            heading: "## The test",
            content: `A disposition colours how the character behaves in situations the profile does not even mention: what they have stopped trusting, what they want, what they cannot stand, what a person or a subject has come to mean to them.

It is not a compulsion. The character can act against a disposition if they choose to — that is what separates it from an automatic reaction they have no say in.

A skill or a habit is not a disposition, and neither is what the character looks like.

The profile may contain zero, one, or several — check for all of them.`,
        },
        {
            heading: "## Already known for these characters (do not duplicate)",
            content: `${currentMap}

Skip anything the list above already states, even in different words. Only write a disposition down if it is genuinely new.`,
        },
        {
            heading: "## Writing an entry",
            content: bulletList([
                "Resolve pronouns and nicknames to actual character names.",
                `"disposition" is one short sentence in the present tense, stating what holds for that character — "distrusts anyone in uniform", "wants out of the city".`,
                "If the profile states what caused it, include it briefly only if stated — don't infer a cause that isn't in the text.",
                "No editorializing about how significant or surprising it is.",
                "Reasoning is just for debug — one concise sentence is enough, covering all findings.",
            ]),
        },
        {
            heading: "## Output format",
            content: `Respond with ONLY a JSON object (no markdown code fence), using exactly this shape:
{"reasoning": "...", "entries": [{"character": "...", "disposition": "..."}]}

If nothing qualifies, use an empty array: {"reasoning": "...", "entries": []}`,
        },
    ], `Profile of ${name}`, profile);
}

// The three layers are one machine with three configurations: same table, same
// backfill and same card seeding. What is deliberately NOT shared is
// the model call — a 4B asked for three kinds at once gets less reliable, and
// a truncated mixed array drops whichever kind came last without looking like
// a failure.
const KNOWLEDGE_LAYERS = {
    facts: {
        id: "facts",
        label: "Facts",
        fields: ["subject", "relation", "object"],
        fieldDescriptions: {
            subject: "Whoever or whatever the fact is about, by name.",
            relation: "The relation, short, lowercase and in the present tense.",
            object: "The other side of the relation.",
        },
        emptyPlaceholder: "Nothing known yet.",
        groupBy: "subject",
        renderEntry: (entry) => `${entry.relation} ${entry.object}`,
        injectHeading: "## Facts",
        injectIntro: "Those are additional facts that could be helpful for your next turn:",
        injectEntry: (entry) => `- ${entry.subject} ${entry.relation} ${entry.object}`,
        buildPrompt: buildFactPrompt,
        buildSeedPrompt: buildFactSeedPrompt,
    },
    dispositions: {
        id: "dispositions",
        label: "Dispositions",
        fields: ["character", "disposition"],
        fieldDescriptions: {
            character: "The character the disposition belongs to, by name.",
            disposition: "One short sentence stating what now holds for them.",
        },
        emptyPlaceholder: "Nothing known yet.",
        groupBy: "character",
        renderEntry: (entry) => entry.disposition,
        injectHeading: "## Dispositions",
        injectIntro: "These are known dispositions for the different Characters:",
        injectEntry: (entry) => `- ${entry.character} ${entry.disposition}`,
        buildPrompt: buildDispositionPrompt,
        buildSeedPrompt: buildDispositionSeedPrompt,
    },
    triggers: {
        id: "triggers",
        label: "Triggers",
        fields: ["character", "trigger", "response"],
        fieldDescriptions: {
            character: "The character the pattern belongs to, by name.",
            trigger: "The condition that sets the pattern off.",
            response: "What reliably happens when it does.",
        },
        emptyPlaceholder: "Nothing known yet.",
        groupBy: "character",
        renderEntry: (entry) => `${entry.trigger} -> ${entry.response}`,
        injectHeading: "## Triggers",
        injectIntro: "The following list of triggers will override the Characters behaviour involuntarily. Play the role accordingly:",
        injectEntry: (entry) => `- When ${entry.character} ${entry.trigger}: ${entry.response}`,
        buildPrompt: buildTriggerMapPrompt,
        buildSeedPrompt: buildTriggerSeedPrompt,
    },
};

const KNOWLEDGE_KEYS = Object.keys(KNOWLEDGE_LAYERS);

function buildKnowledgeSchema(layer, reasoningDescription) {
    const properties = Object.fromEntries(
        layer.fields.map((field) => [field, { type: "string", description: layer.fieldDescriptions[field] }]),
    );
    const required = [...layer.fields];

    return {
        type: "object",
        properties: {
            reasoning: { type: "string", description: reasoningDescription },
            entries: {
                type: "array",
                description: "One object per entry. An empty array when there is nothing to record.",
                items: { type: "object", properties, required, additionalProperties: false },
            },
        },
        required: ["reasoning", "entries"],
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
    knowledge: Object.fromEntries(KNOWLEDGE_KEYS.map((key) => [key, {
        autoExtract: true,
        includeHidden: true,
        injectEnabled: true,
    }])),
    timeline: {
        autoExtract: true,
        includeHidden: true,
        injectEnabled: true,
        injectLimit: 0,
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

// One snapshot, taken before a round of extraction rather than per area: what
// "Restore previous" undoes is everything the last run changed, which is how
// it reads on the sheet. Restoring swaps rather than drops the snapshot, so a
// restore can be taken back too.
const UNDO_KEYS = ["areas", "timeline", "knowledge"];

function captureUndoSnapshot(label) {
    const chatState = ensureChatState();
    chatState.previous = {
        label,
        data: Object.fromEntries(UNDO_KEYS.map((key) => [key, structuredClone(chatState[key])])),
    };
    renderSheetFooter();
}

function restorePreviousState() {
    const chatState = ensureChatState();
    const previous = chatState.previous;
    if (!previous) {
        toastr.info("Nothing to restore yet.", "Psychograph");
        return;
    }

    const current = Object.fromEntries(UNDO_KEYS.map((key) => [key, structuredClone(chatState[key])]));
    for (const key of UNDO_KEYS) {
        chatState[key] = structuredClone(previous.data[key]);
    }
    chatState.previous = { label: `undo of "${previous.label}"`, data: current };

    getContext().saveMetadataDebounced();
    renderChatState();
    toastr.success(`Restored what was there before ${previous.label}.`, "Psychograph");
}

function noteLastExtraction(message, label) {
    const index = getContext().chat.indexOf(message);
    ensureChatState().lastExtraction = { index, label };
    getContext().saveMetadataDebounced();
    renderSheetFooter();
}

const TIMELINE_EXTRACTED_KEY = "psychographTimelineExtracted";

function isTimelineExtracted(message) {
    return Boolean(message?.extra?.[TIMELINE_EXTRACTED_KEY]);
}

function markTimelineExtracted(message) {
    message.extra = message.extra || {};
    message.extra[TIMELINE_EXTRACTED_KEY] = true;
    getContext().saveMetadataDebounced();
}

function ensureSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    settings.cognee = Object.assign(structuredClone(defaultSettings.cognee), settings.cognee);
    settings.timeline = Object.assign(structuredClone(defaultSettings.timeline), settings.timeline);
    settings.knowledge = settings.knowledge || {};
    for (const key of KNOWLEDGE_KEYS) {
        settings.knowledge[key] = Object.assign(
            structuredClone(defaultSettings.knowledge[key]),
            // The trigger layer predates the other two and had settings of its own.
            key === "triggers" ? settings.triggers : undefined,
            settings.knowledge[key],
        );
    }
    delete settings.triggers;
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
    $("#psychograph_similarity_base_url").val(settings.similarity.baseUrl);
    $("#psychograph_similarity_api_key").val(settings.similarity.apiKey);
    $("#psychograph_similarity_rerank_model").val(settings.similarity.rerankModel);
    $("#psychograph_similarity_embedding_model").val(settings.similarity.embeddingModel);
    $("#psychograph_timeline_auto_extract").prop("checked", settings.timeline.autoExtract);
    $("#psychograph_timeline_include_hidden").prop("checked", settings.timeline.includeHidden);
    $("#psychograph_timeline_inject_enabled").prop("checked", settings.timeline.injectEnabled);
    $("#psychograph_timeline_inject_limit").val(settings.timeline.injectLimit);
    for (const key of KNOWLEDGE_KEYS) {
        $(`#psychograph_${key}_auto_extract`).prop("checked", settings.knowledge[key].autoExtract);
        $(`#psychograph_${key}_include_hidden`).prop("checked", settings.knowledge[key].includeHidden);
        $(`#psychograph_${key}_inject_enabled`).prop("checked", settings.knowledge[key].injectEnabled);
    }
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
    renderSheetHeader();

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
        renderSheetHeader();
        getContext().saveMetadataDebounced();
    });

    $("#psychograph_timeline_auto_extract").on("change", function () {
        ensureSettings().timeline.autoExtract = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_timeline_include_hidden").on("change", function () {
        ensureSettings().timeline.includeHidden = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_timeline_inject_enabled").on("change", function () {
        ensureSettings().timeline.injectEnabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_timeline_inject_limit").on("input", function () {
        ensureSettings().timeline.injectLimit = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });

    for (const key of KNOWLEDGE_KEYS) {
        $(`#psychograph_${key}_auto_extract`).on("change", function () {
            ensureSettings().knowledge[key].autoExtract = $(this).prop("checked");
            saveSettingsDebounced();
        });

        $(`#psychograph_${key}_include_hidden`).on("change", function () {
            ensureSettings().knowledge[key].includeHidden = $(this).prop("checked");
            saveSettingsDebounced();
        });

        $(`#psychograph_${key}_inject_enabled`).on("change", function () {
            ensureSettings().knowledge[key].injectEnabled = $(this).prop("checked");
            saveSettingsDebounced();
        });

    }

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
        captureUndoSnapshot("clearing the timeline");
        writeTimeline("");
    });

    $("#psychograph_state_target").on("change", function () {
        ensureChatState().target = String($(this).val());
        renderSheetHeader();
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
    // The chat-completion path JSON.parses the response itself once a schema
    // is in the request, so there is nothing left to parse here.
    if (content && typeof content === "object") {
        return content;
    }

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

// Text completion is the picky mode: SillyTavern only forwards json_schema to
// these two, while every chat-completion source gets a response_format built
// for it. See docs/sillytavern-ui-notes.md.
const SCHEMA_ENFORCING_APIS = new Set(["tabby", "llamacpp"]);

function warnIfSchemaEnforcementUnsupported(profile) {
    if (profile.mode !== "tc") {
        return;
    }

    const api = String(profile.api ?? "").toLowerCase();
    if (api && !SCHEMA_ENFORCING_APIS.has(api)) {
        warnOnce(
            `schema:${profile.id}`,
            `SillyTavern doesn't forward the JSON schema to ${api}, only to TabbyAPI and llama.cpp. Extraction falls back to the prompt alone, which small models follow less reliably.`,
        );
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

    // Both modes read the same field name but not the same shape: text
    // completion takes the bare schema (as the Tabby settings field does),
    // chat completion the wrapper its backend translates per provider.
    const overridePayload = profile.mode === "tc"
        ? { json_schema: schema }
        : { json_schema: { name: schemaName, strict: true, value: schema } };

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
function sanitizeInjectValue(value) {
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
            .map((slot) => [slot, sanitizeInjectValue(chatState.areas[key].slots[slot] ?? "")])
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

async function handleInjectsForGeneration(type, _options, dryRun) {
    if (dryRun || type === "quiet") {
        return;
    }
    await Promise.all([refreshStateInject(), refreshTimelineInject(), refreshKnowledgeInject()]);
}

async function flushStateInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${STATE_INJECT_ID} |`);
}

const TIMELINE_INJECT_ID = "psychograph_timeline";
const TIMELINE_INJECT_HEADING = "## What has happened so far";

// Injected whole by default. The zoom described in docs/memory-architecture.md
// (recent entries individually, older ones merged) needs a pass of its own;
// until then the limit is a blunt cutoff that keeps the most recent entries.
function buildTimelineSnapshot() {
    const settings = ensureSettings();
    if (!settings.timeline.injectEnabled) {
        return "";
    }

    const entries = readTimeline()
        .split("\n")
        .map((line) => sanitizeInjectValue(line).replace(/^[-*]\s*/, ""))
        .filter(Boolean);
    if (entries.length === 0) {
        return "";
    }

    const limit = Number(settings.timeline.injectLimit) || 0;
    const kept = limit > 0 ? entries.slice(-limit) : entries;
    return kept.map((entry) => `- ${entry}`).join("\n");
}

async function refreshTimelineInject() {
    if (!ensureSettings().enabled) {
        return;
    }

    const snapshot = buildTimelineSnapshot();
    if (!snapshot) {
        await flushTimelineInject();
        return;
    }

    await getContext().executeSlashCommandsWithOptions(
        `/inject id=${TIMELINE_INJECT_ID} position=after ephemeral=true scan=true ${TIMELINE_INJECT_HEADING}\n${snapshot} |`,
    );
}

async function flushTimelineInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${TIMELINE_INJECT_ID} |`);
}

const KNOWLEDGE_INJECT_ID = "psychograph_knowledge";

// One inject rather than three: the sections are read together, and their
// order (what is true, what colours behaviour, what overrides it) is part of
// what tells the model how much weight each carries.
function buildKnowledgeSnapshot() {
    const settings = ensureSettings();

    return KNOWLEDGE_KEYS.map((key) => {
        const layer = KNOWLEDGE_LAYERS[key];
        if (!settings.knowledge[key].injectEnabled) {
            return "";
        }

        const lines = readKnowledgeEntries(layer)
            .filter((entry) => layer.fields.every((field) => entry[field]))
            .map((entry) => sanitizeInjectValue(layer.injectEntry(entry)));
        if (lines.length === 0) {
            return "";
        }

        return `${layer.injectHeading}\n${layer.injectIntro}\n${lines.join("\n")}`;
    }).filter(Boolean).join("\n\n");
}

async function refreshKnowledgeInject() {
    if (!ensureSettings().enabled) {
        return;
    }

    const snapshot = buildKnowledgeSnapshot();
    if (!snapshot) {
        await flushKnowledgeInject();
        return;
    }

    await getContext().executeSlashCommandsWithOptions(
        `/inject id=${KNOWLEDGE_INJECT_ID} position=after ephemeral=true scan=true ${snapshot} |`,
    );
}

async function flushKnowledgeInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${KNOWLEDGE_INJECT_ID} |`);
}

function readTimeline() {
    return ensureChatState().timeline ?? "";
}

function writeTimeline(text) {
    ensureChatState().timeline = text;
    $("#psychograph_timeline").val(text);
    renderSheetHeader();
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

async function shouldKeepTimelineEntry(profileId, entry) {
    try {
        const verdict = await sendJsonSchemaRequest(
            profileId,
            "timeline_keep",
            buildTimelineKeepSchema(),
            buildTimelineKeepPrompt(entry),
            TIMELINE_KEEP_MAX_TOKENS,
        );
        console.log(`[Psychograph] Timeline keep reasoning for "${entry}":`, verdict.reasoning);
        return verdict.keep === true;
    } catch (error) {
        // The entry already passed the extraction call, and deleting a line is
        // cheaper than rebuilding the chat to recover one.
        console.error("[Psychograph] Timeline keep call failed, keeping the entry:", error);
        return true;
    }
}

// Both callers append to the same text blob and read it back as the prompt's
// "already on the timeline", so they take turns rather than interleave.
let timelineWork = Promise.resolve();

function queueTimelineWork(task) {
    timelineWork = timelineWork.catch(() => {}).then(task);
    return timelineWork;
}

const TIMELINE_ADDED = "added";
const TIMELINE_DISCARDED = "discarded";
const TIMELINE_SKIPPED = "skipped";
const TIMELINE_FAILED = "failed";

async function extractTimelineEntry(profileId, message) {
    const chatState = ensureChatState();

    try {
        const prompt = buildTimelinePrompt(readTimeline(), readMessageSpeaker(message), message.mes);
        const result = await sendJsonSchemaRequest(profileId, "timeline_entry", buildTimelineSchema(), prompt, TIMELINE_ENTRY_MAX_TOKENS);
        console.log("[Psychograph] Timeline reasoning:", result.reasoning);

        const entry = normalizeTimelineEntry(result.entry);
        if (result.significant !== true || !entry) {
            return TIMELINE_SKIPPED;
        }
        if (!await shouldKeepTimelineEntry(profileId, entry)) {
            return TIMELINE_DISCARDED;
        }
        if (!isCurrentChatState(chatState)) {
            console.warn("[Psychograph] Chat changed during the timeline call, discarding the entry.");
            return TIMELINE_SKIPPED;
        }

        appendTimelineEntry(entry);
        return TIMELINE_ADDED;
    } catch (error) {
        console.error("[Psychograph] Timeline call failed:", error);
        return TIMELINE_FAILED;
    }
}

// Runs on the predecessor for the same reason the State pass does: the newest
// message is still swipeable, and an entry written from a swipe that is then
// replaced cannot be taken back out of an append-only list.
async function extractTimelineForNewMessage(settings, profileId) {
    if (!settings.timeline.autoExtract) {
        return;
    }

    const message = getContext().chat.at(-2);
    if (!isTimelineMessage(message, settings.timeline.includeHidden) || isTimelineExtracted(message)) {
        return;
    }
    markTimelineExtracted(message);

    await queueTimelineWork(() => extractTimelineEntry(profileId, message));
    await refreshTimelineInject();
}

function knowledgeExtractedKey(layer) {
    return `psychographKnowledge_${layer.id}`;
}

function isKnowledgeExtracted(layer, message) {
    return Boolean(message?.extra?.[knowledgeExtractedKey(layer)]);
}

function markKnowledgeExtracted(layer, message) {
    message.extra = message.extra || {};
    message.extra[knowledgeExtractedKey(layer)] = true;
    getContext().saveMetadataDebounced();
}

function readKnowledgeEntries(layer) {
    return ensureChatState().knowledge[layer.id].entries;
}

function writeKnowledgeEntries(layer, entries) {
    ensureChatState().knowledge[layer.id].entries = entries;
    renderKnowledgeGroups();
    getContext().saveMetadataDebounced();
}

function normalizeKnowledgeField(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function readKnowledgeEntry(layer, raw) {
    const entry = Object.fromEntries(layer.fields.map((field) => [field, normalizeKnowledgeField(raw?.[field])]));
    return layer.fields.every((field) => entry[field]) ? entry : null;
}

function renderKnowledgeForPrompt(layer) {
    const entries = readKnowledgeEntries(layer);
    if (entries.length === 0) {
        return layer.emptyPlaceholder;
    }

    if (!layer.groupBy) {
        return entries.map((entry) => `- ${layer.renderEntry(entry)}`).join("\n");
    }

    const grouped = new Map();
    for (const entry of entries) {
        const group = entry[layer.groupBy] || "Unknown";
        if (!grouped.has(group)) {
            grouped.set(group, []);
        }
        grouped.get(group).push(entry);
    }

    return [...grouped.entries()]
        .map(([group, groupEntries]) => `${group}\n${groupEntries.map((entry) => `- ${layer.renderEntry(entry)}`).join("\n")}`)
        .join("\n\n");
}

// One queue per layer: two runs appending to the same list would each be told
// the other's entry does not exist yet. Separate layers never touch the same
// list, so they run side by side.
const knowledgeWork = Object.fromEntries(KNOWLEDGE_KEYS.map((key) => [key, Promise.resolve()]));

function queueKnowledgeWork(layer, task) {
    knowledgeWork[layer.id] = knowledgeWork[layer.id].catch(() => {}).then(task);
    return knowledgeWork[layer.id];
}

const KNOWLEDGE_ENTRY_MAX_TOKENS = 500;

// Budget scales with the input: a profile establishes far more at once than a
// single message does, and a truncated array comes back as invalid JSON, which
// loses every entry rather than the tail.
function knowledgeBudgetFor(text) {
    return Math.min(1500, Math.max(KNOWLEDGE_ENTRY_MAX_TOKENS, Math.round(String(text).length / 4)));
}

async function runKnowledgeCall(layer, profileId, prompt, maxTokens, label) {
    const chatState = ensureChatState();

    try {
        const schema = buildKnowledgeSchema(layer, "One concise sentence covering all findings, before answering.");
        const result = await sendJsonSchemaRequest(profileId, `${layer.id}_${label}`, schema, prompt, maxTokens);
        console.log(`[Psychograph] ${layer.label} ${label} reasoning:`, result.reasoning);

        const found = (Array.isArray(result.entries) ? result.entries : [])
            .map((entry) => readKnowledgeEntry(layer, entry))
            .filter(Boolean);
        if (found.length === 0) {
            return 0;
        }
        if (!isCurrentChatState(chatState)) {
            console.warn(`[Psychograph] Chat changed during the ${layer.label} call, discarding the entries.`);
            return 0;
        }

        writeKnowledgeEntries(layer, [...readKnowledgeEntries(layer), ...found]);
        return found.length;
    } catch (error) {
        console.error(`[Psychograph] ${layer.label} ${label} call failed:`, error);
        return 0;
    }
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

async function extractKnowledgeForNewMessage(layer, settings, profileId) {
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

async function rerunKnowledgeExtractionNow(layer) {
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
async function buildAllKnowledge() {
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
    try {
        // Before message #0: what the card establishes may never come up in the
        // chat at all, and for a profile that is most of what there is to know.
        knowledgeBuildStatus[layer.id] = `${layer.label}: profile…`;
        renderKnowledgeBuildStatus();
        chatState.knowledge[layer.id].seeded = true;
        added += await queueKnowledgeWork(layer, () => seedKnowledgeFromCard(layer, profileId));

        for (let i = 0; i < messages.length; i++) {
            if (knowledgeBuildCancelled[layer.id]) {
                break;
            }
            if (!isCurrentChatState(chatState)) {
                console.warn(`[Psychograph] Chat changed during the ${layer.label} build, stopping.`);
                break;
            }

            knowledgeBuildStatus[layer.id] = `${layer.label} ${i + 1}/${messages.length}, ${added} found`;
            renderKnowledgeBuildStatus();
            added += await queueKnowledgeWork(layer, () => extractKnowledgeFromMessage(layer, profileId, messages[i]));
            markKnowledgeExtracted(layer, messages[i]);
        }

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
    captureUndoSnapshot("the timeline backfill");
    timelineBuildRunning = true;
    timelineBuildCancelled = false;
    $("#psychograph_timeline_build").text("Stop");

    // Every message lands in exactly one of these, so the status line adds up:
    // most messages produce no candidate at all, which the earlier line left
    // unaccounted for and made the numbers look wrong.
    const tally = { [TIMELINE_ADDED]: 0, [TIMELINE_DISCARDED]: 0, [TIMELINE_SKIPPED]: 0, [TIMELINE_FAILED]: 0 };
    let processed = 0;

    const renderBuildStatus = () => {
        const parts = [
            `${processed}/${messages.length} messages`,
            `${tally[TIMELINE_ADDED]} added`,
            `${tally[TIMELINE_DISCARDED]} discarded`,
            `${tally[TIMELINE_SKIPPED]} nothing to log`,
        ];
        if (tally[TIMELINE_FAILED] > 0) {
            parts.push(`${tally[TIMELINE_FAILED]} failed`);
        }
        $("#psychograph_timeline_status").text(`${parts.join(" · ")}…`);
    };

    try {
        renderBuildStatus();
        for (let i = 0; i < messages.length; i++) {
            if (timelineBuildCancelled) {
                break;
            }
            if (!isCurrentChatState(chatState)) {
                console.warn("[Psychograph] Chat changed during the timeline build, stopping.");
                break;
            }

            const outcome = await queueTimelineWork(() => extractTimelineEntry(profileId, messages[i]));
            markTimelineExtracted(messages[i]);
            tally[outcome] += 1;
            processed += 1;
            renderBuildStatus();
        }

        const failures = tally[TIMELINE_FAILED] > 0 ? `, ${tally[TIMELINE_FAILED]} calls failed` : "";
        const summary = `${processed} messages read, ${tally[TIMELINE_ADDED]} entries added, ${tally[TIMELINE_DISCARDED]} discarded as too minor${failures}.`;
        if (timelineBuildCancelled) {
            toastr.info(`Stopped: ${summary}`, "Psychograph");
        } else {
            toastr.success(`Timeline built: ${summary}`, "Psychograph");
        }
    } finally {
        timelineBuildRunning = false;
        $("#psychograph_timeline_build").text("Backfill");
        $("#psychograph_timeline_status").text("");
    }
}

// Rerank and embeddings go straight to the user's own server: SillyTavern has
// no route for either, and its one vector endpoint applies the threshold on the
// server and returns no scores, which is exactly what makes a threshold
// impossible to calibrate.
async function similarityRequest(path, body) {
    const settings = ensureSettings().similarity;
    const headers = { "Content-Type": "application/json" };
    if (settings.apiKey) {
        // Two spellings, because llama.cpp reads the first and TabbyAPI the
        // second, and the servers ignore what they do not know.
        headers.Authorization = `Bearer ${settings.apiKey}`;
        headers["X-Api-Key"] = settings.apiKey;
    }

    const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${path} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
}

const RERANK_PATHS = ["/v1/rerank", "/rerank"];

// llama.cpp answers on both spellings, TabbyAPI and others on one of them, so
// the first that works is remembered rather than asked for in the settings.
async function rerankCandidates(query, documents) {
    const settings = ensureSettings().similarity;
    const paths = settings.rerankPath ? [settings.rerankPath, ...RERANK_PATHS] : RERANK_PATHS;
    let lastError = null;

    for (const path of [...new Set(paths)]) {
        try {
            const result = await similarityRequest(path, {
                model: settings.rerankModel,
                query,
                documents,
                top_n: documents.length,
            });
            const results = result.results ?? result.data ?? [];
            if (settings.rerankPath !== path) {
                settings.rerankPath = path;
                saveSettingsDebounced();
            }
            return results
                .map((entry) => ({ index: Number(entry.index), score: Number(entry.relevance_score ?? entry.score) }))
                .filter((entry) => Number.isInteger(entry.index) && Number.isFinite(entry.score))
                .sort((a, b) => b.score - a.score);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error("No rerank endpoint answered.");
}

async function embedText(input) {
    const settings = ensureSettings().similarity;
    const result = await similarityRequest("/v1/embeddings", { model: settings.embeddingModel, input });
    const embedding = result.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
        throw new Error("The embeddings response carried no vector.");
    }
    return embedding;
}

// Reports a same/different pair of scores rather than just "it works": those
// two numbers are the first real data point for where a threshold belongs on
// this particular model.
async function testSimilarityService() {
    const settings = ensureSettings().similarity;
    const status = $("#psychograph_similarity_status");
    if (!settings.baseUrl) {
        status.text("Set the base URL first.");
        return;
    }

    status.text("Testing…");
    const lines = [];

    try {
        const scores = await rerankCandidates("she goes quiet whenever she smells smoke", [
            "goes silent when there is smoke in the air",
            "keeps a spare key under the doormat",
        ]);
        const byIndex = Object.fromEntries(scores.map((entry) => [entry.index, entry.score.toFixed(4)]));
        lines.push(`rerank ${settings.rerankPath}: same ${byIndex[0]}, unrelated ${byIndex[1]}`);
    } catch (error) {
        console.error("[Psychograph] Rerank test failed:", error);
        lines.push(`rerank: ${error.message}`);
    }

    try {
        const vector = await embedText("test");
        lines.push(`embeddings: ${vector.length} dimensions`);
    } catch (error) {
        console.error("[Psychograph] Embeddings test failed:", error);
        lines.push(`embeddings: ${error.message}`);
    }

    status.text(lines.join(" · "));
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

        const profileId = settings.connectionProfile;
        if (!profileId) {
            warnOnce("profile:none", NO_PROFILE_WARNING);
            console.warn("[Psychograph] No connection profile configured, skipping extraction.");
            return;
        }

        captureUndoSnapshot("the last message");

        // The two layers write to different places and neither reads the
        // other's result, so the timeline call rides alongside the State pass
        // rather than after it.
        await Promise.all([
            extractStateForNewMessage(settings, profileId),
            extractTimelineForNewMessage(settings, profileId),
            ...KNOWLEDGE_KEYS.map((key) => extractKnowledgeForNewMessage(KNOWLEDGE_LAYERS[key], settings, profileId)),
        ]);
    };
}

async function extractStateForNewMessage(settings, profileId) {
    const eligibleAreaKeys = Object.keys(AREA_SLOT_CONFIGS).filter((key) =>
        settings.state.areas[key].enabled);
    if (eligibleAreaKeys.length === 0) {
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
        noteLastExtraction(message, "state");
        const gatedAreaKeys = await runAreaGate(profileId, eligibleAreaKeys, message.mes, speaker);
        await Promise.all(gatedAreaKeys.map((areaKey) => runAreaExtraction(areaKey, message.mes, speaker)));
        await refreshStateInject();
    });
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

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, handleInjectsForGeneration);
    eventSource.on(event_types.GENERATION_ENDED, flushStateInject);
    eventSource.on(event_types.GENERATION_ENDED, flushTimelineInject);
    eventSource.on(event_types.GENERATION_ENDED, flushKnowledgeInject);

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
        captureUndoSnapshot(`the ${config.label.toLowerCase()} extraction`);
        await runAreaExtraction(areaKey, lastMessage.mes, readMessageSpeaker(lastMessage));
        noteLastExtraction(lastMessage, config.label);
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

const SHEET_ID = "psychograph_sheet";
const SHEET_TIMELINE_TAB = "timeline";


let activeSheetTab = STATE_AREAS[0].key;

// "bodyChanges" -> "Body Changes". Every slot name in AREA_SLOT_CONFIGS reads
// as its own label this way, so the sheet needs no second list to maintain.
function humanizeSlot(slot) {
    return slot.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

function buildSheetTabsHtml() {
    const tabs = [
        ...STATE_AREAS.map(({ key }) => ({ key, label: AREA_SLOT_CONFIGS[key].label })),
        { key: SHEET_TIMELINE_TAB, label: "Timeline" },
        { key: SHEET_KNOWLEDGE_TAB, label: "Knowledge" },
    ];
    return tabs.map(({ key, label }) => `
        <div class="psychograph-sheet-tab" data-tab="${key}">${label}</div>
    `).join("");
}

function buildSheetAreaPaneHtml(areaKey) {
    const config = AREA_SLOT_CONFIGS[areaKey];
    const fields = config.slots.map((slot) => `
        <label for="psychograph_state_${config.id}_slot_${slot}">${humanizeSlot(slot)}</label>
        <input id="psychograph_state_${config.id}_slot_${slot}" type="text" class="text_pole" placeholder="${config.slotPlaceholders[slot]}" />
    `).join("");

    return `
        <div class="psychograph-sheet-pane" data-tab="${areaKey}">
            <div class="psychograph-sheet-pane-header">
                <label class="checkbox_label" for="psychograph_state_${config.id}_enabled">
                    <input id="psychograph_state_${config.id}_enabled" type="checkbox" />
                    Enabled
                </label>
                <span class="psychograph-sheet-count">${config.slots.length} fields</span>
            </div>
            <div class="psychograph-sheet-fields">${fields}</div>
        </div>
    `;
}

function buildSheetTimelinePaneHtml() {
    return `
        <div class="psychograph-sheet-pane" data-tab="${SHEET_TIMELINE_TAB}">
            <div class="psychograph-sheet-pane-header">
                <label class="checkbox_label" for="psychograph_timeline_auto_extract">
                    <input id="psychograph_timeline_auto_extract" type="checkbox" />
                    Enabled
                </label>
                <span id="psychograph_sheet_timeline_count" class="psychograph-sheet-count"></span>
                <div class="psychograph-sheet-options-toggle fa-solid fa-gear interactable" data-tab="${SHEET_TIMELINE_TAB}" title="Settings" tabindex="0"></div>
            </div>
            <div class="psychograph-sheet-actions">
                <div id="psychograph_timeline_build" class="menu_button" title="Read every message in this chat">Backfill</div>
                <div id="psychograph_timeline_clear" class="menu_button">Clear</div>
            </div>
            <small id="psychograph_timeline_status" class="psychograph-sheet-hint"></small>
            <div class="psychograph-sheet-options" data-tab="${SHEET_TIMELINE_TAB}">
                <label class="checkbox_label" for="psychograph_timeline_include_hidden">
                    <input id="psychograph_timeline_include_hidden" type="checkbox" />
                    Include hidden messages
                </label>
                <label class="checkbox_label" for="psychograph_timeline_inject_enabled">
                    <input id="psychograph_timeline_inject_enabled" type="checkbox" />
                    Inject into the prompt
                </label>
                <label for="psychograph_timeline_inject_limit">Most recent entries only (0 = all)</label>
                <input id="psychograph_timeline_inject_limit" type="number" min="0" step="1" class="text_pole" />
            </div>
            <div class="psychograph-sheet-fields">
                <label for="psychograph_timeline">Current timeline</label>
                <textarea id="psychograph_timeline" class="text_pole textarea_compact" rows="12" placeholder="- ..."></textarea>
            </div>
        </div>
    `;
}

const SHEET_KNOWLEDGE_TAB = "knowledge";

function buildSheetKnowledgePaneHtml() {
    const layerSettings = KNOWLEDGE_KEYS.map((key) => {
        const layer = KNOWLEDGE_LAYERS[key];
        return `
            <div class="psychograph-knowledge-settings">
                <label class="checkbox_label" for="psychograph_${key}_auto_extract">
                    <input id="psychograph_${key}_auto_extract" type="checkbox" />
                    ${layer.label}: extract on every message
                </label>
                <label class="checkbox_label" for="psychograph_${key}_include_hidden">
                    <input id="psychograph_${key}_include_hidden" type="checkbox" />
                    ${layer.label}: include hidden messages
                </label>
                <label class="checkbox_label" for="psychograph_${key}_inject_enabled">
                    <input id="psychograph_${key}_inject_enabled" type="checkbox" />
                    ${layer.label}: inject into the prompt
                </label>
            </div>
        `;
    }).join("");

    return `
        <div class="psychograph-sheet-pane" data-tab="${SHEET_KNOWLEDGE_TAB}">
            <div class="psychograph-sheet-pane-header">
                <span id="psychograph_knowledge_count" class="psychograph-sheet-count"></span>
                <div class="psychograph-sheet-options-toggle fa-solid fa-gear interactable" data-tab="${SHEET_KNOWLEDGE_TAB}" title="Settings" tabindex="0"></div>
            </div>
            <div class="psychograph-sheet-actions">
                <div id="psychograph_knowledge_build" class="menu_button" title="Read the character profiles, then every message in this chat">Backfill</div>
                <div id="psychograph_knowledge_clear" class="menu_button" title="Empty all three lists for this chat">Clear all</div>
            </div>
            <small id="psychograph_knowledge_status" class="psychograph-sheet-hint"></small>
            <div class="psychograph-sheet-options" data-tab="${SHEET_KNOWLEDGE_TAB}">${layerSettings}</div>
            <div id="psychograph_knowledge_groups"></div>
            <div id="psychograph_knowledge_add_group" class="psychograph-knowledge-add interactable" title="Add an entry for someone new" tabindex="0">
                <i class="fa-solid fa-plus"></i> Add someone
            </div>
        </div>
    `;
}

function buildSheetBodyHtml() {
    return `
        <div class="psychograph-sheet-title">
            <span class="psychograph-sheet-heading">Character Sheet</span>
            <span id="psychograph_sheet_character" class="psychograph-sheet-subject"></span>
        </div>
        <div class="psychograph-sheet-tabs">${buildSheetTabsHtml()}</div>
        <div class="psychograph-sheet-applies">
            <label for="psychograph_state_target">Applies to</label>
            <select id="psychograph_state_target" class="text_pole" title="Whether tracked state reflects the character or the user persona. Extraction runs on every message either way.">
                <option value="char">Character</option>
                <option value="user">User persona</option>
            </select>
        </div>
        <div class="psychograph-sheet-content">
            ${STATE_AREAS.map(({ key }) => buildSheetAreaPaneHtml(key)).join("")}
            ${buildSheetTimelinePaneHtml()}
            ${buildSheetKnowledgePaneHtml()}
        </div>
        <div class="psychograph-sheet-footer">
            <span id="psychograph_sheet_status" class="psychograph-sheet-hint"></span>
            <div class="psychograph-sheet-footer-buttons">
                <div id="psychograph_sheet_restore" class="menu_button" title="Undo what the last extraction changed">Restore</div>
                <div id="psychograph_sheet_extract" class="menu_button">Extract now</div>
            </div>
        </div>
    `;
}

// Same construction SillyTavern uses for its own floating panels (see the
// Summarize extension): the zoomed-avatar template carries the control bar and
// the classes dragElement expects, and the grabber's id has to be the panel's
// id with "header" appended or dragElement won't find it.
function buildSheetPanel() {
    if ($(`#${SHEET_ID}`).length > 0) {
        return;
    }

    const movingDivs = document.getElementById("movingDivs");
    if (!movingDivs) {
        console.warn("[Psychograph] #movingDivs not found, skipping the character sheet panel.");
        return;
    }

    const template = $("#zoomed_avatar_template").html();
    const panel = template ? $(template) : $("<div></div>");
    panel
        .attr("id", SHEET_ID)
        .removeClass("zoomed_avatar")
        .addClass("draggable psychograph-sheet")
        .empty()
        .append(`
            <div class="panelControlBar flex-container">
                <div id="${SHEET_ID}header" class="fa-solid fa-grip drag-grabber hoverglow"></div>
                <div id="psychograph_sheet_close" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
            </div>
            <div class="psychograph-sheet-body">${buildSheetBodyHtml()}</div>
        `);

    $(movingDivs).append(panel);
    loadMovingUIState();
    dragElement(panel);
    selectSheetTab(activeSheetTab);
}

function toggleSheetPanel() {
    const panel = $(`#${SHEET_ID}`);
    if (panel.length === 0) {
        return;
    }
    if (panel.hasClass("shown")) {
        panel.removeClass("shown");
        return;
    }
    renderChatState();
    panel.addClass("shown");
}

function selectSheetTab(tab) {
    activeSheetTab = tab;
    $(`#${SHEET_ID} .psychograph-sheet-tab`).each(function () {
        $(this).toggleClass("active", String($(this).data("tab")) === tab);
    });
    $(`#${SHEET_ID} .psychograph-sheet-pane`).each(function () {
        $(this).toggleClass("active", String($(this).data("tab")) === tab);
    });
}

function renderSheetHeader() {
    $("#psychograph_sheet_character").text(readTargetName());
    const entries = readTimeline().split("\n").filter((line) => line.trim()).length;
    $("#psychograph_sheet_timeline_count").text(`${entries} ${entries === 1 ? "entry" : "entries"}`);
    renderKnowledgeGroups();
    renderSheetFooter();
}

function escapeHtmlAttribute(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Section state is per character and layer, and deliberately not persisted: it
// is how the panel looks right now, not something about the chat. Only sections
// the user has actually toggled are in here — everything else follows the
// default of "open when it has entries", which is why an empty section can
// still be opened to add the first one.
const knowledgeSectionState = new Map();

function knowledgeSectionKey(group, layerKey) {
    return `${group}::${layerKey}`;
}

const UNNAMED_KNOWLEDGE_GROUP = "Someone";

// Groups in order of first appearance, across all three layers at once — the
// sheet is read per character, not per layer.
function collectKnowledgeGroups() {
    const groups = new Map();

    for (const key of KNOWLEDGE_KEYS) {
        const layer = KNOWLEDGE_LAYERS[key];
        readKnowledgeEntries(layer).forEach((entry, index) => {
            const name = entry[layer.groupBy] || "";
            if (!groups.has(name)) {
                groups.set(name, Object.fromEntries(KNOWLEDGE_KEYS.map((layerKey) => [layerKey, []])));
            }
            groups.get(name)[key].push({ entry, index });
        });
    }

    return groups;
}

function buildKnowledgeEntryHtml(layerKey, { entry, index }) {
    const layer = KNOWLEDGE_LAYERS[layerKey];
    const fields = layer.fields
        .filter((field) => field !== layer.groupBy)
        .map((field) => `
            <input type="text" class="psychograph-knowledge-input" data-field="${field}"
                placeholder="${humanizeSlot(field).toLowerCase()}" value="${escapeHtmlAttribute(entry[field])}" />
        `).join("");

    // Redundant with the heading above it, and there anyway: it is the only way
    // to move a single entry to someone else without touching its neighbours.
    const owner = `
        <label class="psychograph-knowledge-owner">
            <i class="fa-solid fa-user"></i>
            <input type="text" class="psychograph-knowledge-input psychograph-knowledge-owner-input"
                data-field="${layer.groupBy}" placeholder="${UNNAMED_KNOWLEDGE_GROUP}"
                title="Move just this entry to someone else"
                value="${escapeHtmlAttribute(entry[layer.groupBy])}" />
        </label>
    `;

    return `
        <div class="psychograph-knowledge-entry" data-layer="${layerKey}" data-index="${index}">
            <div class="psychograph-knowledge-entry-fields">${fields}${owner}</div>
            <div class="psychograph-knowledge-delete fa-solid fa-xmark interactable" title="Delete entry" tabindex="0"></div>
        </div>
    `;
}

function buildKnowledgeSectionHtml(group, layerKey, rows) {
    const layer = KNOWLEDGE_LAYERS[layerKey];
    const key = knowledgeSectionKey(group, layerKey);
    const collapsed = !(knowledgeSectionState.has(key) ? knowledgeSectionState.get(key) : rows.length > 0);

    return `
        <div class="psychograph-knowledge-section${collapsed ? "" : " open"}" data-group="${escapeHtmlAttribute(group)}" data-layer="${layerKey}">
            <div class="psychograph-knowledge-section-header interactable" tabindex="0">
                <i class="fa-solid fa-chevron-${collapsed ? "right" : "down"}"></i>
                <span>${layer.label}</span>
                <span class="psychograph-sheet-count">${rows.length}</span>
            </div>
            <div class="psychograph-knowledge-entries">
                ${rows.map((row) => buildKnowledgeEntryHtml(layerKey, row)).join("")}
                <div class="psychograph-knowledge-add interactable" data-group="${escapeHtmlAttribute(group)}" data-layer="${layerKey}" tabindex="0">
                    <i class="fa-solid fa-plus"></i> Add ${layer.label.toLowerCase().replace(/s$/, "")}
                </div>
            </div>
        </div>
    `;
}

function renderKnowledgeGroups() {
    const groups = collectKnowledgeGroups();
    const total = KNOWLEDGE_KEYS.reduce((sum, key) => sum + readKnowledgeEntries(KNOWLEDGE_LAYERS[key]).length, 0);

    const html = [...groups.entries()].map(([group, rowsByLayer]) => `
        <div class="psychograph-knowledge-group" data-group="${escapeHtmlAttribute(group)}">
            <input type="text" class="psychograph-knowledge-group-name" value="${escapeHtmlAttribute(group)}"
                placeholder="${UNNAMED_KNOWLEDGE_GROUP}" title="Renaming moves every entry below to that name" />
            ${KNOWLEDGE_KEYS.map((key) => buildKnowledgeSectionHtml(group, key, rowsByLayer[key])).join("")}
        </div>
    `).join("");

    $("#psychograph_knowledge_groups").html(html);
    $("#psychograph_knowledge_count").text(`${total} ${total === 1 ? "entry" : "entries"}`);
}

function renderSheetFooter() {
    const chatState = ensureChatState();
    const last = chatState.lastExtraction;
    $("#psychograph_sheet_status").text(
        last && last.index >= 0 ? `last extraction · msg #${last.index}` : "nothing extracted yet",
    );
    $("#psychograph_sheet_restore").toggleClass("disabled", !chatState.previous);
}

// The three layers share one set of buttons. Nothing orders them against each
// other, so one press runs all three at once.
async function runForEveryKnowledgeLayer(action) {
    await Promise.all(KNOWLEDGE_KEYS.map((key) => action(KNOWLEDGE_LAYERS[key])));
}

async function extractActiveSheetTabNow() {
    if (activeSheetTab === SHEET_TIMELINE_TAB) {
        await rerunTimelineExtractionNow();
        return;
    }
    if (activeSheetTab === SHEET_KNOWLEDGE_TAB) {
        await runForEveryKnowledgeLayer(rerunKnowledgeExtractionNow);
        return;
    }
    await rerunAreaExtractionNow(activeSheetTab);
}

async function rerunTimelineExtractionNow() {
    const settings = ensureSettings();
    if (!settings.connectionProfile) {
        toastr.warning(NO_PROFILE_WARNING, "Psychograph");
        return;
    }

    const message = getContext().chat.at(-1);
    if (!isTimelineMessage(message, settings.timeline.includeHidden)) {
        toastr.warning("The last message is a system or hidden message, nothing to analyze.", "Psychograph");
        return;
    }

    toastr.info("Checking the last message for a timeline entry…", "Psychograph");
    captureUndoSnapshot("the timeline entry");
    const outcome = await queueTimelineWork(() => extractTimelineEntry(settings.connectionProfile, message));
    markTimelineExtracted(message);

    if (outcome === TIMELINE_ADDED) {
        toastr.success("Entry added to the timeline.", "Psychograph");
    } else if (outcome === TIMELINE_DISCARDED) {
        toastr.info("Entry discarded as too minor.", "Psychograph");
    } else if (outcome === TIMELINE_FAILED) {
        toastr.error("The timeline call failed, see the console.", "Psychograph");
    } else {
        toastr.info("Nothing worth logging in that message.", "Psychograph");
    }
}

function bindSheetEvents() {
    const panel = $(`#${SHEET_ID}`);

    $("#psychograph_sheet_close").on("click", function () {
        panel.removeClass("shown");
    });

    panel.on("click", ".psychograph-sheet-tab", function () {
        selectSheetTab(String($(this).data("tab")));
    });

    panel.on("click", ".psychograph-sheet-options-toggle", function () {
        $(`.psychograph-sheet-options[data-tab="${$(this).data("tab")}"]`).toggleClass("shown");
    });

    $("#psychograph_sheet_extract").on("click", extractActiveSheetTabNow);
    $("#psychograph_sheet_restore").on("click", restorePreviousState);
    $("#psychograph_knowledge_build").on("click", buildAllKnowledge);

    $("#psychograph_knowledge_clear").on("click", async function () {
        const context = getContext();
        const confirmed = await context.callGenericPopup(
            "Clear the facts, dispositions and triggers of this chat? Restore previous can bring them back until the next extraction.",
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        captureUndoSnapshot("clearing the knowledge lists");
        for (const key of KNOWLEDGE_KEYS) {
            // Cleared by hand means the card should be read again on the next
            // pass, or an emptied list would stay empty for the rest of the chat.
            ensureChatState().knowledge[key].seeded = false;
            writeKnowledgeEntries(KNOWLEDGE_LAYERS[key], []);
        }
    });

    $("#psychograph_knowledge_add_group").on("click", function () {
        const layer = KNOWLEDGE_LAYERS[KNOWLEDGE_KEYS[0]];
        writeKnowledgeEntries(layer, [
            ...readKnowledgeEntries(layer),
            Object.fromEntries(layer.fields.map((field) => [field, ""])),
        ]);
        $(".psychograph-knowledge-group").last().find(".psychograph-knowledge-group-name").trigger("focus");
    });

    panel.on("click", ".psychograph-knowledge-section-header", function () {
        const section = $(this).closest(".psychograph-knowledge-section");
        const key = knowledgeSectionKey(String(section.data("group")), String(section.data("layer")));
        knowledgeSectionState.set(key, !section.hasClass("open"));
        renderKnowledgeGroups();
    });

    panel.on("click", ".psychograph-knowledge-add[data-layer]", function () {
        const layer = KNOWLEDGE_LAYERS[String($(this).data("layer"))];
        const group = String($(this).data("group"));
        knowledgeSectionState.set(knowledgeSectionKey(group, layer.id), true);
        writeKnowledgeEntries(layer, [
            ...readKnowledgeEntries(layer),
            Object.fromEntries(layer.fields.map((field) => [field, field === layer.groupBy ? group : ""])),
        ]);
    });

    // Renaming moves every entry under that heading, across all three layers —
    // fixing "Milly" to "Milena" once is the common case, and it merges the two
    // groups as a side effect.
    panel.on("change", ".psychograph-knowledge-group-name", function () {
        const previous = String($(this).closest(".psychograph-knowledge-group").data("group"));
        const name = String($(this).val()).trim();
        captureUndoSnapshot("renaming a group");
        for (const key of KNOWLEDGE_KEYS) {
            const layer = KNOWLEDGE_LAYERS[key];
            const entries = readKnowledgeEntries(layer).map((entry) =>
                (entry[layer.groupBy] || "") === previous ? { ...entry, [layer.groupBy]: name } : entry);
            ensureChatState().knowledge[key].entries = entries;
        }
        getContext().saveMetadataDebounced();
        renderKnowledgeGroups();
    });

    panel.on("change", ".psychograph-knowledge-owner-input", function () {
        renderKnowledgeGroups();
    });

    panel.on("input", ".psychograph-knowledge-input", function () {
        const layer = KNOWLEDGE_LAYERS[String($(this).closest(".psychograph-knowledge-entry").data("layer"))];
        const index = Number($(this).closest(".psychograph-knowledge-entry").data("index"));
        const entries = readKnowledgeEntries(layer);
        if (!entries[index]) {
            return;
        }
        entries[index][String($(this).data("field"))] = String($(this).val());
        getContext().saveMetadataDebounced();
    });

    panel.on("click", ".psychograph-knowledge-delete", function () {
        const entryElement = $(this).closest(".psychograph-knowledge-entry");
        const layer = KNOWLEDGE_LAYERS[String(entryElement.data("layer"))];
        const index = Number(entryElement.data("index"));
        captureUndoSnapshot(`deleting a ${layer.label.toLowerCase()} entry`);
        writeKnowledgeEntries(layer, readKnowledgeEntries(layer).filter((_, position) => position !== index));
    });

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
        <div id="psychograph_menu_button" class="psychograph-toolbar-button fa-solid fa-brain interactable" title="Character sheet" tabindex="0"></div>
        <div class="psychograph-guided-buttons">
            <div id="psychograph_guided_swipe_button" class="psychograph-toolbar-button fa-solid fa-forward interactable" title="Guided Swipe" tabindex="0"></div>
            <div id="psychograph_guided_message_button" class="psychograph-toolbar-button fa-solid fa-comment-dots interactable" title="Guided Message" tabindex="0"></div>
            <div id="psychograph_guided_continue_button" class="psychograph-toolbar-button fa-solid fa-arrow-right interactable" title="Guided Continue" tabindex="0"></div>
        </div>
    `);

    $("#psychograph_guided_message_button").on("click", guidedMessage);
    $("#psychograph_guided_swipe_button").on("click", guidedSwipe);
    $("#psychograph_guided_continue_button").on("click", guidedContinue);
    $("#psychograph_menu_button").on("click", toggleSheetPanel);
}

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);

    buildSheetPanel();
    bindSettingsEvents();
    bindSheetEvents();
    bindChatEvents();
    buildToolbarButton();
    renderSettings();
    populateConnectionProfiles();
});
