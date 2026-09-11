import { SEED_MODE } from "../constants.js";
import { AREA_SLOT_CONFIGS } from "../layers/state/areas.js";
import { buildAttributionRule, buildHintSection, buildPromptDocument, buildSheetIntro, bulletList, qualifiedSlotName } from "./document.js";

export function buildAreaDiffPrompt(config, slots, message, speaker, mode) {
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

export function buildAreaDiffSchema(config, slots, mode) {
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

export function buildAreaSlotUpdatePrompt(config, slot, currentState, message, speaker, mode) {
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

export function buildAreaSlotUpdateSchema(config, mode) {
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
export function buildAreaGatePrompt(eligibleAreaKeys, message, speaker) {
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

export function buildAreaGateSchema(eligibleAreaKeys) {
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
