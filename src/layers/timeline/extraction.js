import { getContext } from "../../sillytavern.js";
import { ensureChatState, isCurrentChatState } from "../../chat-state.js";
import { refreshTimelineInject } from "../../injects.js";
import { NO_PROFILE_WARNING, sendJsonSchemaRequest } from "../../llm/request.js";
import { isTimelineExtracted, isTimelineMessage, markTimelineExtracted, readMessageSpeaker } from "../../messages.js";
import { buildTimelineKeepPrompt, buildTimelineKeepSchema, buildTimelinePrompt, buildTimelineSchema } from "../../prompts/timeline.js";
import { ensureSettings } from "../../settings.js";
import { captureUndoSnapshot } from "../../undo.js";
import { TIMELINE_ADDED, TIMELINE_DISCARDED, TIMELINE_FAILED, TIMELINE_SKIPPED, appendTimelineEntry, normalizeTimelineEntry, queueTimelineWork, readTimeline } from "./store.js";

const TIMELINE_ENTRY_MAX_TOKENS = 300;

const TIMELINE_KEEP_MAX_TOKENS = 200;

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
export async function extractTimelineForNewMessage(settings, profileId) {
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

let timelineBuildRunning = false;

let timelineBuildCancelled = false;

// Every message is offered to the model, including ones an earlier build
// already saw: what keeps a rebuild from duplicating entries is the timeline
// itself being in the prompt, not a per-message marker.
export async function buildTimeline() {
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

export async function rerunTimelineExtractionNow() {
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
