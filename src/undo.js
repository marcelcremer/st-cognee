import { getContext } from "./sillytavern.js";
import { ensureChatState } from "./chat-state.js";
import { renderChatState } from "./ui/settings-panel.js";
import { renderSheetFooter } from "./ui/sheet.js";

// One snapshot, taken before a round of extraction rather than per area: what
// "Restore previous" undoes is everything the last run changed, which is how
// it reads on the sheet. Restoring swaps rather than drops the snapshot, so a
// restore can be taken back too.
const UNDO_KEYS = ["areas", "timeline", "knowledge"];

export function captureUndoSnapshot(label) {
    const chatState = ensureChatState();
    chatState.previous = {
        label,
        data: Object.fromEntries(UNDO_KEYS.map((key) => [key, structuredClone(chatState[key])])),
    };
    renderSheetFooter();
}

export function restorePreviousState() {
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

export function noteLastExtraction(message, label) {
    const index = getContext().chat.indexOf(message);
    ensureChatState().lastExtraction = { index, label };
    getContext().saveMetadataDebounced();
    renderSheetFooter();
}
