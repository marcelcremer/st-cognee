import { guidedContinue, guidedMessage, guidedSwipe } from "./guided.js";
import { toggleSheetPanel } from "./sheet.js";

export function buildToolbarButton() {
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
        <div id="psychograph_activity" class="psychograph-activity fa-solid fa-circle-notch" title="Psychograph is reading the last messages"></div>
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

let missingActivityReported = false;

// Never the hidden attribute: this element sits in SillyTavern's own button row
// and any author-level display rule would silently win over it. See
// docs/sillytavern-ui-notes.md.
export function renderExtractionActivity(pending) {
    const activity = $("#psychograph_activity");
    if (activity.length === 0) {
        if (!missingActivityReported) {
            missingActivityReported = true;
            console.warn("[Psychograph] #psychograph_activity is not in the DOM, so the spinner cannot show. A stale cached toolbar.js is the usual cause.");
        }
        return;
    }

    activity
        .toggleClass("shown", pending > 0)
        .attr("title", pending === 1
            ? "Psychograph is reading 1 message"
            : `Psychograph is reading ${pending} messages`);
}
