import { extensionFolderPath } from "./src/constants.js";
import { bindChatEvents } from "./src/events.js";
import { bindSettingsEvents, populateConnectionProfiles, renderSettings } from "./src/ui/settings-panel.js";
import { bindSheetEvents, buildSheetPanel } from "./src/ui/sheet.js";
import { buildToolbarButton } from "./src/ui/toolbar.js";

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);

    buildSheetPanel();
    bindSettingsEvents();
    bindSheetEvents();
    bindChatEvents();
    buildToolbarButton();
    renderSettings();
    populateConnectionProfiles();
});
