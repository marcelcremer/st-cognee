import { getContext } from "./sillytavern.js";
import { ensureChatState, readTargetName } from "./chat-state.js";
import { getCogneeChatId, recallFromCognee } from "./layers/cognee.js";
import { KNOWLEDGE_KEYS, KNOWLEDGE_LAYERS } from "./layers/knowledge/layers.js";
import { readKnowledgeEntries } from "./layers/knowledge/store.js";
import { buildGoalInject, buildMotivationInject } from "./layers/motivation/drivers.js";
import { nextMotivationRoll, readMotivationGoal } from "./layers/motivation/lottery.js";
import { AREA_SLOT_CONFIGS, STATE_AREAS } from "./layers/state/areas.js";
import { readTimeline } from "./layers/timeline/store.js";
import { ensureSettings } from "./settings.js";

const STATE_INJECT_ID = "psychograph_state";

const STATE_INJECT_HEADING = "## Current state information";

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
export async function refreshStateInject() {
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

export async function handleInjectsForGeneration(type, _options, dryRun) {
    if (dryRun || type === "quiet") {
        return;
    }
    await Promise.all([refreshStateInject(), refreshTimelineInject(), refreshKnowledgeInject(), refreshMotivationInject()]);
}

export async function flushStateInject() {
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

export async function refreshTimelineInject() {
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

export async function flushTimelineInject() {
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

export async function flushKnowledgeInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${KNOWLEDGE_INJECT_ID} |`);
}

const MOTIVATION_INJECT_ID = "psychograph_motivation";

// The one inject that does not go to position=after: it carries a fresh value
// every turn, and the context template sits in front of the whole chat, so an
// anchor there would invalidate the prompt cache down to the story string.
// depth=0 puts it behind the last message instead, where only it is new.
async function refreshMotivationInject() {
    const settings = ensureSettings();
    if (!settings.enabled || !settings.motivation.enabled) {
        await flushMotivationInject();
        return;
    }

    const goal = readMotivationGoal();
    const snapshot = [
        goal.enabled ? buildGoalInject(sanitizeInjectValue(goal.text)) : "",
        buildMotivationInject(nextMotivationRoll()),
    ].filter(Boolean).join("\n\n");
    if (!snapshot) {
        await flushMotivationInject();
        return;
    }

    await getContext().executeSlashCommandsWithOptions(
        `/inject id=${MOTIVATION_INJECT_ID} position=chat depth=0 role=system ephemeral=true scan=false ${snapshot} |`,
    );
}

export async function flushMotivationInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${MOTIVATION_INJECT_ID} |`);
}

const COGNEE_RECALL_INJECT_ID = "psychograph_cognee_recall";

const COGNEE_RECALL_HEADING = "### Long-term context";

// Hooked on GENERATION_AFTER_COMMANDS (awaited by SillyTavern) so this
// network round trip lands in the same turn rather than the next one.
let cogneeRecallInFlight = false;

export async function handleCogneeRecall(type, _options, dryRun) {
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

export async function flushCogneeRecallInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${COGNEE_RECALL_INJECT_ID} |`);
}
