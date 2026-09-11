import { getContext } from "../../sillytavern.js";
import { ensureChatState } from "../../chat-state.js";
import { renderSheetHeader } from "../../ui/sheet.js";

export function readTimeline() {
    return ensureChatState().timeline ?? "";
}

export function writeTimeline(text) {
    ensureChatState().timeline = text;
    $("#psychograph_timeline").val(text);
    renderSheetHeader();
    getContext().saveMetadataDebounced();
}

// The model is asked for a sentence, not for markup, but it sees a bullet list
// in the prompt and sometimes answers in kind.
export function normalizeTimelineEntry(entry) {
    return String(entry ?? "").replace(/\s+/g, " ").replace(/^[-*]\s*/, "").trim();
}

export function appendTimelineEntry(entry) {
    const existing = readTimeline().trimEnd();
    writeTimeline(existing ? `${existing}\n- ${entry}` : `- ${entry}`);
}

// Both callers append to the same text blob and read it back as the prompt's
// "already on the timeline", so they take turns rather than interleave.
let timelineWork = Promise.resolve();

export function queueTimelineWork(task) {
    timelineWork = timelineWork.catch(() => {}).then(task);
    return timelineWork;
}

export const TIMELINE_ADDED = "added";

export const TIMELINE_DISCARDED = "discarded";

export const TIMELINE_SKIPPED = "skipped";

export const TIMELINE_FAILED = "failed";
