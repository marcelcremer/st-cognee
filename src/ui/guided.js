import { eventSource, event_types, getContext } from "../sillytavern.js";
import { sanitizeStscriptValue } from "../stscript.js";

const GUIDED_INJECT_ID = "psychograph_guide";

// One flag across all four buttons, not one per action: they all read and write
// the same input field and the same last message, so a second one starting
// while the first is mid-generation corrupts both.
let inputActionRunning = false;

async function runInputAction(name, action) {
    if (inputActionRunning) {
        toastr.info("Another input action is still running.", `Psychograph: ${name}`);
        return;
    }

    const textarea = document.getElementById("send_textarea");
    if (!textarea) {
        console.error(`[Psychograph] ${name}: #send_textarea not found.`);
        return;
    }

    inputActionRunning = true;
    try {
        await action(textarea);
    } catch (error) {
        console.error(`[Psychograph] ${name} failed:`, error);
        toastr.error(String(error?.message ?? error), `Psychograph: ${name}`);
    } finally {
        inputActionRunning = false;
    }
}

function setInput(textarea, value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function injectGuideText(text) {
    const value = sanitizeStscriptValue(text);
    if (!value) {
        return false;
    }

    const context = getContext();
    await context.executeSlashCommandsWithOptions(
        `/inject id=${GUIDED_INJECT_ID} position=chat ephemeral=true scan=true depth=0 role=system ${value} |`,
    );

    // An inject that did not land produces a perfectly normal, unguided reply,
    // which is the one failure mode nobody notices. Better to not generate.
    if (!getContext().chatMetadata?.script_injects?.[GUIDED_INJECT_ID]) {
        throw new Error("The guidance was not injected, so nothing was generated.");
    }
    return true;
}

async function flushGuideInject() {
    await getContext().executeSlashCommandsWithOptions(`/flushinject ${GUIDED_INJECT_ID} |`);
}

function resolveLastCharacterMessage(name) {
    const chat = getContext().chat;
    const index = chat.length - 1;
    const message = chat[index];

    if (!message) {
        toastr.info("There is no message to work on yet.", `Psychograph: ${name}`);
        return null;
    }
    if (message.is_user) {
        toastr.info("The last message is yours — this only works on a character message.", `Psychograph: ${name}`);
        return null;
    }
    return { index, message };
}

function renderMessageText(index) {
    const context = getContext();
    const message = context.chat[index];
    const row = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!message || !row) {
        return;
    }

    const body = row.querySelector(".mes_text");
    if (body && typeof context.messageFormatting === "function") {
        body.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, index);
    }
    if (Array.isArray(message.swipes)) {
        const counter = `${(message.swipe_id ?? 0) + 1}/${message.swipes.length}`;
        for (const element of row.querySelectorAll(".swipes-counter")) {
            element.textContent = counter;
        }
    }
}

// swipe.right() only generates once the newest swipe is the one on screen —
// from an earlier one it just steps forward through what already exists. So a
// guided swipe taken after swiping back would silently show an old swipe and
// throw the guidance away.
async function focusLastSwipe(index) {
    const message = getContext().chat[index];
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    const target = swipes.length - 1;
    if (swipes.length < 2 || (message.swipe_id ?? 0) === target) {
        return;
    }

    message.swipe_id = target;
    message.mes = swipes[target];
    const extra = message.swipe_info?.[target]?.extra;
    if (extra) {
        message.extra = structuredClone(extra);
    }

    renderMessageText(index);
    await eventSource.emit(event_types.MESSAGE_SWIPED, index);
    getContext().saveMetadataDebounced();
}

export async function guidedMessage() {
    await runInputAction("Guided Message", async (textarea) => {
        const originalInput = textarea.value;
        let injected = false;
        try {
            injected = await injectGuideText(originalInput);
            await getContext().executeSlashCommandsWithOptions("/trigger await=true |");
        } finally {
            setInput(textarea, originalInput);
            if (injected) {
                await flushGuideInject();
            }
        }
    });
}

export async function guidedSwipe() {
    await runInputAction("Guided Swipe", async (textarea) => {
        const context = getContext();
        if (!context.swipe?.right) {
            toastr.error("This SillyTavern version has no swipe.right() — 1.13.0 or newer is needed.", "Psychograph");
            return;
        }

        const target = resolveLastCharacterMessage("Guided Swipe");
        if (!target) {
            return;
        }
        await focusLastSwipe(target.index);

        const originalInput = textarea.value;
        let injected = false;
        try {
            injected = await injectGuideText(originalInput);
            await context.swipe.right();
        } finally {
            setInput(textarea, originalInput);
            if (injected) {
                await flushGuideInject();
            }
        }
    });
}

export async function guidedContinue() {
    await runInputAction("Guided Continue", async (textarea) => {
        const target = resolveLastCharacterMessage("Guided Continue");
        if (!target) {
            return;
        }

        // Read before the generation: /continue writes into the message in
        // place, so afterwards there is nothing left to compare against.
        const before = String(target.message.mes ?? "");
        const originalInput = textarea.value;
        const guidance = sanitizeStscriptValue(originalInput);

        try {
            await getContext().executeSlashCommandsWithOptions(
                guidance ? `/continue await=true ${guidance} |` : "/continue await=true |",
            );
        } finally {
            setInput(textarea, originalInput);
        }

        offerContinueUndo(target.index, before);
    });
}

function offerContinueUndo(index, before) {
    const after = String(getContext().chat[index]?.mes ?? "");
    if (after === before) {
        toastr.info("The continuation added nothing.", "Psychograph: Guided Continue");
        return;
    }
    if (!after.startsWith(before)) {
        console.warn("[Psychograph] Guided Continue rewrote the message instead of extending it, so no undo is offered.");
        return;
    }

    toastr.info("Click here to undo it.", "Psychograph: Guided Continue", {
        timeOut: 12000,
        onclick: () => {
            undoContinue(index, before).catch((error) => {
                console.error("[Psychograph] Undoing the continuation failed:", error);
            });
        },
    });
}

async function undoContinue(index, before) {
    const message = getContext().chat[index];
    if (!message || !String(message.mes ?? "").startsWith(before)) {
        toastr.warning("The message changed since, so the continuation was left alone.", "Psychograph");
        return;
    }

    message.mes = before;
    message.is_edited = true;
    // The active swipe keeps its own copy of the text; without this the
    // continuation is back as soon as the message is re-rendered.
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
        message.swipes[message.swipe_id] = before;
    }

    renderMessageText(index);
    await eventSource.emit(event_types.MESSAGE_EDITED, index);
    getContext().saveMetadataDebounced();
    if (event_types.MESSAGE_UPDATED) {
        await eventSource.emit(event_types.MESSAGE_UPDATED, index);
    }
}

export async function simpleSend() {
    await runInputAction("Send without reply", async (textarea) => {
        if (!textarea.value.trim()) {
            return;
        }

        // {{input}} rather than the text itself: the macro is substituted after
        // the command has been parsed, so a message containing "|" cannot end
        // the command early and run its remainder as a command of its own.
        await getContext().executeSlashCommandsWithOptions("/send {{input}} |");
        setInput(textarea, "");
    });
}
