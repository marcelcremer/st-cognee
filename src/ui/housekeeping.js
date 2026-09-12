import { saveSettingsDebounced } from "../sillytavern.js";
import { applyHousekeeping, readHousekeepingCounts } from "../housekeeping.js";
import { ensureSettings } from "../settings.js";

export const SHEET_HOUSEKEEPING_TAB = "housekeeping";

export function buildSheetHousekeepingPaneHtml() {
    return `
        <div class="psychograph-sheet-pane" data-tab="${SHEET_HOUSEKEEPING_TAB}">
            <div class="psychograph-sheet-pane-header">
                <label class="checkbox_label" for="psychograph_housekeeping_enabled">
                    <input id="psychograph_housekeeping_enabled" type="checkbox" />
                    Enabled
                </label>
                <span id="psychograph_housekeeping_count" class="psychograph-sheet-count"></span>
            </div>
            <small class="psychograph-sheet-hint">Keeps only the most recent messages in the prompt and marks everything older hidden, the way /hide does. While enabled, every new message hides whatever has just fallen out of the window &mdash; it never unhides, so a message you hid by hand stays hidden. "Apply now" applies the window retroactively, in both directions.</small>
            <div class="psychograph-sheet-fields">
                <label for="psychograph_housekeeping_keep">Messages still injected (0 = all)</label>
                <input id="psychograph_housekeeping_keep" type="number" min="0" step="1" class="text_pole" />
            </div>
            <div class="psychograph-sheet-actions">
                <div id="psychograph_housekeeping_apply" class="menu_button" title="Hide every message older than the window and unhide the ones inside it">Apply now</div>
            </div>
            <small id="psychograph_housekeeping_status" class="psychograph-sheet-hint"></small>
        </div>
    `;
}

// Separate from renderHousekeeping so the automatic pass, which runs on every
// message, refreshes the count without writing over the number field while it
// is being typed into.
export function renderHousekeepingCount() {
    const { total, visible } = readHousekeepingCounts();
    $("#psychograph_housekeeping_count").text(`${visible} of ${total} injected`);
}

export function renderHousekeeping() {
    const settings = ensureSettings().housekeeping;
    $("#psychograph_housekeeping_enabled").prop("checked", settings.enabled);
    $("#psychograph_housekeeping_keep").val(settings.keepVisible);
    renderHousekeepingCount();
}

export function bindHousekeepingEvents() {
    $("#psychograph_housekeeping_enabled").on("change", function () {
        ensureSettings().housekeeping.enabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_housekeeping_keep").on("input", function () {
        ensureSettings().housekeeping.keepVisible = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });

    $("#psychograph_housekeeping_apply").on("click", async function () {
        const status = $("#psychograph_housekeeping_status");
        if (ensureSettings().housekeeping.keepVisible <= 0) {
            status.text("Set a number above 0 first — 0 keeps every message injected.");
            return;
        }

        status.text("applying…");
        const { hide, unhide } = await applyHousekeeping();
        renderHousekeepingCount();
        status.text(`${hide.length} hidden, ${unhide.length} unhidden`);
    });
}
