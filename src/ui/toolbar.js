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
