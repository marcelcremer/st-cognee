import { getContext } from "../../sillytavern.js";
import { ensureChatState, isCurrentChatState } from "../../chat-state.js";
import { sendJsonSchemaRequest } from "../../llm/request.js";
import { rerankCandidates } from "../../llm/similarity.js";
import { buildKnowledgeMergePrompt, buildKnowledgeSchema } from "../../prompts/knowledge.js";
import { ensureSettings } from "../../settings.js";
import { renderKnowledgeGroups } from "../../ui/sheet.js";
import { KNOWLEDGE_KEYS, KNOWLEDGE_MERGE_MAX_TOKENS } from "./layers.js";

export function readKnowledgeEntries(layer) {
    return ensureChatState().knowledge[layer.id].entries;
}

export function writeKnowledgeEntries(layer, entries) {
    ensureChatState().knowledge[layer.id].entries = entries;
    renderKnowledgeGroups();
    getContext().saveMetadataDebounced();
}

function normalizeKnowledgeField(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function readKnowledgeEntry(layer, raw) {
    const entry = Object.fromEntries(layer.fields.map((field) => [field, normalizeKnowledgeField(raw?.[field])]));
    return layer.fields.every((field) => entry[field]) ? entry : null;
}

export function renderKnowledgeForPrompt(layer) {
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

export function queueKnowledgeWork(layer, task) {
    knowledgeWork[layer.id] = knowledgeWork[layer.id].catch(() => {}).then(task);
    return knowledgeWork[layer.id];
}

// Knowledge only. The timeline runs its own extraction and is deliberately left
// out: its entries are events in an order, where two similar lines can both be
// true, and its "already on the timeline" test is the significance filter
// itself rather than a duplicate check.
function isDuplicateSearchConfigured() {
    const settings = ensureSettings().similarity;
    return Boolean(settings.baseUrl && settings.rerankModel);
}

// Only entries about the same character or subject can be duplicates of each
// other, so the comparison never leaves the group — cheaper, and it makes a
// cross-character merge impossible rather than unlikely.
function knowledgeSiblings(layer, candidate) {
    const entries = readKnowledgeEntries(layer);
    if (!layer.groupBy) {
        return entries.map((entry, index) => ({ entry, index }));
    }

    const group = candidate[layer.groupBy];
    return entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry[layer.groupBy] === group);
}

async function findKnowledgeDuplicate(layer, candidate) {
    const siblings = knowledgeSiblings(layer, candidate);
    if (siblings.length === 0 || !isDuplicateSearchConfigured()) {
        return null;
    }

    try {
        const scores = await rerankCandidates(
            layer.injectEntry(candidate),
            siblings.map(({ entry }) => layer.injectEntry(entry)),
        );
        const best = scores[0];
        if (!best) {
            return null;
        }

        const sibling = siblings[best.index];
        const threshold = Number(ensureSettings().similarity.duplicateThreshold);
        console.log(
            `[Psychograph] ${layer.label} candidate "${layer.injectEntry(candidate)}" | closest "${layer.injectEntry(sibling.entry)}" | score ${best.score.toFixed(4)} | threshold ${threshold}`,
        );
        return best.score >= threshold ? sibling : null;
    } catch (error) {
        // A scorer that is down must not stop entries from being recorded.
        console.error(`[Psychograph] ${layer.label} duplicate search failed, keeping the entry as new:`, error);
        return null;
    }
}

async function mergeKnowledgeEntries(layer, profileId, existing, candidate) {
    try {
        const result = await sendJsonSchemaRequest(
            profileId,
            `${layer.id}_merge`,
            buildKnowledgeSchema(layer, "One concise sentence on what the two entries have in common."),
            buildKnowledgeMergePrompt(layer, existing, candidate),
            KNOWLEDGE_MERGE_MAX_TOKENS,
        );
        console.log(`[Psychograph] ${layer.label} merge reasoning:`, result.reasoning);
        return readKnowledgeEntry(layer, result);
    } catch (error) {
        console.error(`[Psychograph] ${layer.label} merge call failed, keeping the entry that was already there:`, error);
        return null;
    }
}

// Every candidate is handled on its own and against the list as it stands, so
// two near-identical entries from the same call meet each other too.
async function absorbKnowledgeEntry(layer, profileId, candidate) {
    const duplicate = await findKnowledgeDuplicate(layer, candidate);
    if (!duplicate) {
        writeKnowledgeEntries(layer, [...readKnowledgeEntries(layer), candidate]);
        return "added";
    }

    if (!ensureSettings().similarity.mergeDuplicates) {
        console.log(`[Psychograph] ${layer.label}: duplicate of #${duplicate.index + 1}, dropped.`);
        return "duplicate";
    }

    const merged = await mergeKnowledgeEntries(layer, profileId, duplicate.entry, candidate);
    if (!merged) {
        return "duplicate";
    }

    const entries = [...readKnowledgeEntries(layer)];
    entries[duplicate.index] = merged;
    writeKnowledgeEntries(layer, entries);
    return "merged";
}

export async function absorbKnowledgeEntries(layer, profileId, candidates, chatState) {
    let recorded = 0;
    for (const candidate of candidates) {
        if (!isCurrentChatState(chatState)) {
            console.warn(`[Psychograph] Chat changed while taking in ${layer.label}, dropping what is left.`);
            return recorded;
        }
        if (await absorbKnowledgeEntry(layer, profileId, candidate) !== "duplicate") {
            recorded += 1;
        }
    }
    return recorded;
}
