import { dragElement, getContext, loadMovingUIState } from "../sillytavern.js";
import { ensureChatState, readTargetName } from "../chat-state.js";
import { buildAllKnowledge, rerunKnowledgeExtractionNow } from "../layers/knowledge/extraction.js";
import { KNOWLEDGE_KEYS, KNOWLEDGE_LAYERS } from "../layers/knowledge/layers.js";
import { readKnowledgeEntries, writeKnowledgeEntries } from "../layers/knowledge/store.js";
import { AREA_SLOT_CONFIGS, STATE_AREAS } from "../layers/state/areas.js";
import { rerunAreaExtractionNow } from "../layers/state/extraction.js";
import { rerunTimelineExtractionNow } from "../layers/timeline/extraction.js";
import { readTimeline } from "../layers/timeline/store.js";
import { captureUndoSnapshot, restorePreviousState } from "../undo.js";
import { renderChatState } from "./settings-panel.js";

const SHEET_ID = "psychograph_sheet";

const SHEET_TIMELINE_TAB = "timeline";

let activeSheetTab = STATE_AREAS[0].key;

// "bodyChanges" -> "Body Changes". Every slot name in AREA_SLOT_CONFIGS reads
// as its own label this way, so the sheet needs no second list to maintain.
function humanizeSlot(slot) {
    return slot.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

function buildSheetTabsHtml() {
    const tabs = [
        ...STATE_AREAS.map(({ key }) => ({ key, label: AREA_SLOT_CONFIGS[key].label })),
        { key: SHEET_TIMELINE_TAB, label: "Timeline" },
        { key: SHEET_KNOWLEDGE_TAB, label: "Knowledge" },
    ];
    return tabs.map(({ key, label }) => `
        <div class="psychograph-sheet-tab" data-tab="${key}">${label}</div>
    `).join("");
}

function buildSheetAreaPaneHtml(areaKey) {
    const config = AREA_SLOT_CONFIGS[areaKey];
    const fields = config.slots.map((slot) => `
        <label for="psychograph_state_${config.id}_slot_${slot}">${humanizeSlot(slot)}</label>
        <input id="psychograph_state_${config.id}_slot_${slot}" type="text" class="text_pole" placeholder="${config.slotPlaceholders[slot]}" />
    `).join("");

    return `
        <div class="psychograph-sheet-pane" data-tab="${areaKey}">
            <div class="psychograph-sheet-pane-header">
                <label class="checkbox_label" for="psychograph_state_${config.id}_enabled">
                    <input id="psychograph_state_${config.id}_enabled" type="checkbox" />
                    Enabled
                </label>
                <span class="psychograph-sheet-count">${config.slots.length} fields</span>
            </div>
            <div class="psychograph-sheet-fields">${fields}</div>
        </div>
    `;
}

function buildSheetTimelinePaneHtml() {
    return `
        <div class="psychograph-sheet-pane" data-tab="${SHEET_TIMELINE_TAB}">
            <div class="psychograph-sheet-pane-header">
                <label class="checkbox_label" for="psychograph_timeline_auto_extract">
                    <input id="psychograph_timeline_auto_extract" type="checkbox" />
                    Enabled
                </label>
                <span id="psychograph_sheet_timeline_count" class="psychograph-sheet-count"></span>
                <div class="psychograph-sheet-options-toggle fa-solid fa-gear interactable" data-tab="${SHEET_TIMELINE_TAB}" title="Settings" tabindex="0"></div>
            </div>
            <div class="psychograph-sheet-actions">
                <div id="psychograph_timeline_build" class="menu_button" title="Read every message in this chat">Backfill</div>
                <div id="psychograph_timeline_clear" class="menu_button">Clear</div>
            </div>
            <small id="psychograph_timeline_status" class="psychograph-sheet-hint"></small>
            <div class="psychograph-sheet-options" data-tab="${SHEET_TIMELINE_TAB}">
                <label class="checkbox_label" for="psychograph_timeline_include_hidden">
                    <input id="psychograph_timeline_include_hidden" type="checkbox" />
                    Include hidden messages
                </label>
                <label class="checkbox_label" for="psychograph_timeline_inject_enabled">
                    <input id="psychograph_timeline_inject_enabled" type="checkbox" />
                    Inject into the prompt
                </label>
                <label for="psychograph_timeline_inject_limit">Most recent entries only (0 = all)</label>
                <input id="psychograph_timeline_inject_limit" type="number" min="0" step="1" class="text_pole" />
            </div>
            <div class="psychograph-sheet-fields">
                <label for="psychograph_timeline">Current timeline</label>
                <textarea id="psychograph_timeline" class="text_pole textarea_compact" rows="12" placeholder="- ..."></textarea>
            </div>
        </div>
    `;
}

const SHEET_KNOWLEDGE_TAB = "knowledge";

function buildSheetKnowledgePaneHtml() {
    const layerSettings = KNOWLEDGE_KEYS.map((key) => {
        const layer = KNOWLEDGE_LAYERS[key];
        return `
            <div class="psychograph-knowledge-settings">
                <label class="checkbox_label" for="psychograph_${key}_auto_extract">
                    <input id="psychograph_${key}_auto_extract" type="checkbox" />
                    ${layer.label}: extract on every message
                </label>
                <label class="checkbox_label" for="psychograph_${key}_include_hidden">
                    <input id="psychograph_${key}_include_hidden" type="checkbox" />
                    ${layer.label}: include hidden messages
                </label>
                <label class="checkbox_label" for="psychograph_${key}_inject_enabled">
                    <input id="psychograph_${key}_inject_enabled" type="checkbox" />
                    ${layer.label}: inject into the prompt
                </label>
            </div>
        `;
    }).join("");

    return `
        <div class="psychograph-sheet-pane" data-tab="${SHEET_KNOWLEDGE_TAB}">
            <div class="psychograph-sheet-pane-header">
                <span id="psychograph_knowledge_count" class="psychograph-sheet-count"></span>
                <div class="psychograph-sheet-options-toggle fa-solid fa-gear interactable" data-tab="${SHEET_KNOWLEDGE_TAB}" title="Settings" tabindex="0"></div>
            </div>
            <div class="psychograph-sheet-actions">
                <div id="psychograph_knowledge_build" class="menu_button" title="Read the character profiles, then every message in this chat">Backfill</div>
                <div id="psychograph_knowledge_clear" class="menu_button" title="Empty all three lists for this chat">Clear all</div>
            </div>
            <small id="psychograph_knowledge_status" class="psychograph-sheet-hint"></small>
            <div class="psychograph-sheet-options" data-tab="${SHEET_KNOWLEDGE_TAB}">${layerSettings}</div>
            <div id="psychograph_knowledge_groups"></div>
            <div id="psychograph_knowledge_add_group" class="psychograph-knowledge-add interactable" title="Add an entry for someone new" tabindex="0">
                <i class="fa-solid fa-plus"></i> Add someone
            </div>
        </div>
    `;
}

function buildSheetBodyHtml() {
    return `
        <div class="psychograph-sheet-title">
            <span class="psychograph-sheet-heading">Character Sheet</span>
            <span id="psychograph_sheet_character" class="psychograph-sheet-subject"></span>
        </div>
        <div class="psychograph-sheet-tabs">${buildSheetTabsHtml()}</div>
        <div class="psychograph-sheet-applies">
            <label for="psychograph_state_target">Applies to</label>
            <select id="psychograph_state_target" class="text_pole" title="Whether tracked state reflects the character or the user persona. Extraction runs on every message either way.">
                <option value="char">Character</option>
                <option value="user">User persona</option>
            </select>
        </div>
        <div class="psychograph-sheet-content">
            ${STATE_AREAS.map(({ key }) => buildSheetAreaPaneHtml(key)).join("")}
            ${buildSheetTimelinePaneHtml()}
            ${buildSheetKnowledgePaneHtml()}
        </div>
        <div class="psychograph-sheet-footer">
            <span id="psychograph_sheet_status" class="psychograph-sheet-hint"></span>
            <div class="psychograph-sheet-footer-buttons">
                <div id="psychograph_sheet_restore" class="menu_button" title="Undo what the last extraction changed">Restore</div>
                <div id="psychograph_sheet_extract" class="menu_button">Extract now</div>
            </div>
        </div>
    `;
}

// Same construction SillyTavern uses for its own floating panels (see the
// Summarize extension): the zoomed-avatar template carries the control bar and
// the classes dragElement expects, and the grabber's id has to be the panel's
// id with "header" appended or dragElement won't find it.
export function buildSheetPanel() {
    if ($(`#${SHEET_ID}`).length > 0) {
        return;
    }

    const movingDivs = document.getElementById("movingDivs");
    if (!movingDivs) {
        console.warn("[Psychograph] #movingDivs not found, skipping the character sheet panel.");
        return;
    }

    const template = $("#zoomed_avatar_template").html();
    const panel = template ? $(template) : $("<div></div>");
    panel
        .attr("id", SHEET_ID)
        .removeClass("zoomed_avatar")
        .addClass("draggable psychograph-sheet")
        .empty()
        .append(`
            <div class="panelControlBar flex-container">
                <div id="${SHEET_ID}header" class="fa-solid fa-grip drag-grabber hoverglow"></div>
                <div id="psychograph_sheet_close" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
            </div>
            <div class="psychograph-sheet-body">${buildSheetBodyHtml()}</div>
        `);

    $(movingDivs).append(panel);
    loadMovingUIState();
    dragElement(panel);
    selectSheetTab(activeSheetTab);
}

export function toggleSheetPanel() {
    const panel = $(`#${SHEET_ID}`);
    if (panel.length === 0) {
        return;
    }
    if (panel.hasClass("shown")) {
        panel.removeClass("shown");
        return;
    }
    renderChatState();
    panel.addClass("shown");
}

function selectSheetTab(tab) {
    activeSheetTab = tab;
    $(`#${SHEET_ID} .psychograph-sheet-tab`).each(function () {
        $(this).toggleClass("active", String($(this).data("tab")) === tab);
    });
    $(`#${SHEET_ID} .psychograph-sheet-pane`).each(function () {
        $(this).toggleClass("active", String($(this).data("tab")) === tab);
    });
}

export function renderSheetHeader() {
    $("#psychograph_sheet_character").text(readTargetName());
    const entries = readTimeline().split("\n").filter((line) => line.trim()).length;
    $("#psychograph_sheet_timeline_count").text(`${entries} ${entries === 1 ? "entry" : "entries"}`);
    renderKnowledgeGroups();
    renderSheetFooter();
}

function escapeHtmlAttribute(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Section state is per character and layer, and deliberately not persisted: it
// is how the panel looks right now, not something about the chat. Only sections
// the user has actually toggled are in here — everything else follows the
// default of "open when it has entries", which is why an empty section can
// still be opened to add the first one.
const knowledgeSectionState = new Map();

function knowledgeSectionKey(group, layerKey) {
    return `${group}::${layerKey}`;
}

const UNNAMED_KNOWLEDGE_GROUP = "Someone";

// Groups in order of first appearance, across all three layers at once — the
// sheet is read per character, not per layer.
function collectKnowledgeGroups() {
    const groups = new Map();

    for (const key of KNOWLEDGE_KEYS) {
        const layer = KNOWLEDGE_LAYERS[key];
        readKnowledgeEntries(layer).forEach((entry, index) => {
            const name = entry[layer.groupBy] || "";
            if (!groups.has(name)) {
                groups.set(name, Object.fromEntries(KNOWLEDGE_KEYS.map((layerKey) => [layerKey, []])));
            }
            groups.get(name)[key].push({ entry, index });
        });
    }

    return groups;
}

function buildKnowledgeEntryHtml(layerKey, { entry, index }) {
    const layer = KNOWLEDGE_LAYERS[layerKey];
    const fields = layer.fields
        .filter((field) => field !== layer.groupBy)
        .map((field) => `
            <input type="text" class="psychograph-knowledge-input" data-field="${field}"
                placeholder="${humanizeSlot(field).toLowerCase()}" value="${escapeHtmlAttribute(entry[field])}" />
        `).join("");

    // Redundant with the heading above it, and there anyway: it is the only way
    // to move a single entry to someone else without touching its neighbours.
    const owner = `
        <label class="psychograph-knowledge-owner">
            <i class="fa-solid fa-user"></i>
            <input type="text" class="psychograph-knowledge-input psychograph-knowledge-owner-input"
                data-field="${layer.groupBy}" placeholder="${UNNAMED_KNOWLEDGE_GROUP}"
                title="Move just this entry to someone else"
                value="${escapeHtmlAttribute(entry[layer.groupBy])}" />
        </label>
    `;

    return `
        <div class="psychograph-knowledge-entry" data-layer="${layerKey}" data-index="${index}">
            <div class="psychograph-knowledge-entry-fields">${fields}${owner}</div>
            <div class="psychograph-knowledge-delete fa-solid fa-xmark interactable" title="Delete entry" tabindex="0"></div>
        </div>
    `;
}

function buildKnowledgeSectionHtml(group, layerKey, rows) {
    const layer = KNOWLEDGE_LAYERS[layerKey];
    const key = knowledgeSectionKey(group, layerKey);
    const collapsed = !(knowledgeSectionState.has(key) ? knowledgeSectionState.get(key) : rows.length > 0);

    return `
        <div class="psychograph-knowledge-section${collapsed ? "" : " open"}" data-group="${escapeHtmlAttribute(group)}" data-layer="${layerKey}">
            <div class="psychograph-knowledge-section-header interactable" tabindex="0">
                <i class="fa-solid fa-chevron-${collapsed ? "right" : "down"}"></i>
                <span>${layer.label}</span>
                <span class="psychograph-sheet-count">${rows.length}</span>
            </div>
            <div class="psychograph-knowledge-entries">
                ${rows.map((row) => buildKnowledgeEntryHtml(layerKey, row)).join("")}
                <div class="psychograph-knowledge-add interactable" data-group="${escapeHtmlAttribute(group)}" data-layer="${layerKey}" tabindex="0">
                    <i class="fa-solid fa-plus"></i> Add ${layer.label.toLowerCase().replace(/s$/, "")}
                </div>
            </div>
        </div>
    `;
}

export function renderKnowledgeGroups() {
    const groups = collectKnowledgeGroups();
    const total = KNOWLEDGE_KEYS.reduce((sum, key) => sum + readKnowledgeEntries(KNOWLEDGE_LAYERS[key]).length, 0);

    const html = [...groups.entries()].map(([group, rowsByLayer]) => `
        <div class="psychograph-knowledge-group" data-group="${escapeHtmlAttribute(group)}">
            <input type="text" class="psychograph-knowledge-group-name" value="${escapeHtmlAttribute(group)}"
                placeholder="${UNNAMED_KNOWLEDGE_GROUP}" title="Renaming moves every entry below to that name" />
            ${KNOWLEDGE_KEYS.map((key) => buildKnowledgeSectionHtml(group, key, rowsByLayer[key])).join("")}
        </div>
    `).join("");

    $("#psychograph_knowledge_groups").html(html);
    $("#psychograph_knowledge_count").text(`${total} ${total === 1 ? "entry" : "entries"}`);
}

export function renderSheetFooter() {
    const chatState = ensureChatState();
    const last = chatState.lastExtraction;
    $("#psychograph_sheet_status").text(
        last && last.index >= 0 ? `last extraction · msg #${last.index}` : "nothing extracted yet",
    );
    $("#psychograph_sheet_restore").toggleClass("disabled", !chatState.previous);
}

// The three layers share one set of buttons. Nothing orders them against each
// other, so one press runs all three at once.
async function runForEveryKnowledgeLayer(action) {
    await Promise.all(KNOWLEDGE_KEYS.map((key) => action(KNOWLEDGE_LAYERS[key])));
}

async function extractActiveSheetTabNow() {
    if (activeSheetTab === SHEET_TIMELINE_TAB) {
        await rerunTimelineExtractionNow();
        return;
    }
    if (activeSheetTab === SHEET_KNOWLEDGE_TAB) {
        await runForEveryKnowledgeLayer(rerunKnowledgeExtractionNow);
        return;
    }
    await rerunAreaExtractionNow(activeSheetTab);
}

export function bindSheetEvents() {
    const panel = $(`#${SHEET_ID}`);

    $("#psychograph_sheet_close").on("click", function () {
        panel.removeClass("shown");
    });

    panel.on("click", ".psychograph-sheet-tab", function () {
        selectSheetTab(String($(this).data("tab")));
    });

    panel.on("click", ".psychograph-sheet-options-toggle", function () {
        $(`.psychograph-sheet-options[data-tab="${$(this).data("tab")}"]`).toggleClass("shown");
    });

    $("#psychograph_sheet_extract").on("click", extractActiveSheetTabNow);
    $("#psychograph_sheet_restore").on("click", restorePreviousState);
    $("#psychograph_knowledge_build").on("click", buildAllKnowledge);

    $("#psychograph_knowledge_clear").on("click", async function () {
        const context = getContext();
        const confirmed = await context.callGenericPopup(
            "Clear the facts, dispositions and triggers of this chat? Restore previous can bring them back until the next extraction.",
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        captureUndoSnapshot("clearing the knowledge lists");
        for (const key of KNOWLEDGE_KEYS) {
            // Cleared by hand means the card should be read again on the next
            // pass, or an emptied list would stay empty for the rest of the chat.
            ensureChatState().knowledge[key].seeded = false;
            writeKnowledgeEntries(KNOWLEDGE_LAYERS[key], []);
        }
    });

    $("#psychograph_knowledge_add_group").on("click", function () {
        const layer = KNOWLEDGE_LAYERS[KNOWLEDGE_KEYS[0]];
        writeKnowledgeEntries(layer, [
            ...readKnowledgeEntries(layer),
            Object.fromEntries(layer.fields.map((field) => [field, ""])),
        ]);
        $(".psychograph-knowledge-group").last().find(".psychograph-knowledge-group-name").trigger("focus");
    });

    panel.on("click", ".psychograph-knowledge-section-header", function () {
        const section = $(this).closest(".psychograph-knowledge-section");
        const key = knowledgeSectionKey(String(section.data("group")), String(section.data("layer")));
        knowledgeSectionState.set(key, !section.hasClass("open"));
        renderKnowledgeGroups();
    });

    panel.on("click", ".psychograph-knowledge-add[data-layer]", function () {
        const layer = KNOWLEDGE_LAYERS[String($(this).data("layer"))];
        const group = String($(this).data("group"));
        knowledgeSectionState.set(knowledgeSectionKey(group, layer.id), true);
        writeKnowledgeEntries(layer, [
            ...readKnowledgeEntries(layer),
            Object.fromEntries(layer.fields.map((field) => [field, field === layer.groupBy ? group : ""])),
        ]);
    });

    // Renaming moves every entry under that heading, across all three layers —
    // fixing "Milly" to "Milena" once is the common case, and it merges the two
    // groups as a side effect.
    panel.on("change", ".psychograph-knowledge-group-name", function () {
        const previous = String($(this).closest(".psychograph-knowledge-group").data("group"));
        const name = String($(this).val()).trim();
        captureUndoSnapshot("renaming a group");
        for (const key of KNOWLEDGE_KEYS) {
            const layer = KNOWLEDGE_LAYERS[key];
            const entries = readKnowledgeEntries(layer).map((entry) =>
                (entry[layer.groupBy] || "") === previous ? { ...entry, [layer.groupBy]: name } : entry);
            ensureChatState().knowledge[key].entries = entries;
        }
        getContext().saveMetadataDebounced();
        renderKnowledgeGroups();
    });

    panel.on("change", ".psychograph-knowledge-owner-input", function () {
        renderKnowledgeGroups();
    });

    panel.on("input", ".psychograph-knowledge-input", function () {
        const layer = KNOWLEDGE_LAYERS[String($(this).closest(".psychograph-knowledge-entry").data("layer"))];
        const index = Number($(this).closest(".psychograph-knowledge-entry").data("index"));
        const entries = readKnowledgeEntries(layer);
        if (!entries[index]) {
            return;
        }
        entries[index][String($(this).data("field"))] = String($(this).val());
        getContext().saveMetadataDebounced();
    });

    panel.on("click", ".psychograph-knowledge-delete", function () {
        const entryElement = $(this).closest(".psychograph-knowledge-entry");
        const layer = KNOWLEDGE_LAYERS[String(entryElement.data("layer"))];
        const index = Number(entryElement.data("index"));
        captureUndoSnapshot(`deleting a ${layer.label.toLowerCase()} entry`);
        writeKnowledgeEntries(layer, readKnowledgeEntries(layer).filter((_, position) => position !== index));
    });

}
