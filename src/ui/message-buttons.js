import { rereadMessageForState } from "../layers/state/extraction.js";

const REREAD_BUTTON_CLASS = "psychograph_reread";

// #message_template is what every message is rendered from, so the button goes
// in there for messages to come and into the ones already on screen. The click
// is delegated from #chat because that markup is replaced wholesale on a chat
// switch and on every re-render.
export function buildMessageButtons() {
    const button = `<div title="Psychograph: read this message again" class="mes_button ${REREAD_BUTTON_CLASS} fa-solid fa-brain interactable" tabindex="0"></div>`;

    const template = $(`#message_template .extraMesButtons`);
    if (template.length === 0) {
        console.warn("[Psychograph] #message_template not found, skipping the per-message button.");
        return;
    }
    if (template.find(`.${REREAD_BUTTON_CLASS}`).length === 0) {
        template.prepend(button);
    }
    $(`#chat .mes .extraMesButtons`).each(function () {
        if ($(this).find(`.${REREAD_BUTTON_CLASS}`).length === 0) {
            $(this).prepend(button);
        }
    });

    $(document).on("click", `.${REREAD_BUTTON_CLASS}`, function () {
        rereadMessageForState(Number($(this).closest(".mes").attr("mesid")));
    });
}
