import { eventSource, event_types, extension_settings, getContext, saveSettingsDebounced } from "../sillytavern.js";
import { ensureChatState } from "../chat-state.js";
import { backfillChatHistoryToCognee, readCogneeChatId, writeCogneeChatId } from "../layers/cognee.js";
import { KNOWLEDGE_KEYS } from "../layers/knowledge/layers.js";
import { AREA_SLOT_CONFIGS, STATE_AREAS } from "../layers/state/areas.js";
import { buildTimeline } from "../layers/timeline/extraction.js";
import { writeTimeline } from "../layers/timeline/store.js";
import { shownConfigWarnings } from "../llm/request.js";
import { testSimilarityService } from "../llm/similarity.js";
import { ensureSettings } from "../settings.js";
import { captureUndoSnapshot } from "../undo.js";
import { renderSheetHeader } from "./sheet.js";

export function populateConnectionProfiles() {
    const select = $("#psychograph_connection_profile");
    const settings = ensureSettings();
    const profiles = extension_settings.connectionManager?.profiles ?? [];

    select.empty();
    select.append($("<option>").val("").text("SillyTavern default"));
    for (const profile of profiles) {
        select.append($("<option>").val(profile.id).text(profile.name || profile.id));
    }

    select.val(settings.connectionProfile);
}

export function renderSettings() {
    const settings = ensureSettings();
    $("#psychograph_enabled").prop("checked", settings.enabled);
    $("#psychograph_connection_profile").val(settings.connectionProfile);
    $("#psychograph_parallel_requests").val(settings.parallelRequests);
    $("#psychograph_cognee_base_url").val(settings.cognee.baseUrl);
    $("#psychograph_cognee_api_key").val(settings.cognee.apiKey);
    $("#psychograph_cognee_enabled").prop("checked", settings.cognee.enabled);
    $("#psychograph_cognee_recall_enabled").prop("checked", settings.cognee.recallEnabled);
    $("#psychograph_similarity_base_url").val(settings.similarity.baseUrl);
    $("#psychograph_similarity_api_key").val(settings.similarity.apiKey);
    $("#psychograph_similarity_rerank_model").val(settings.similarity.rerankModel);
    $("#psychograph_similarity_embedding_model").val(settings.similarity.embeddingModel);
    $("#psychograph_similarity_threshold").val(settings.similarity.duplicateThreshold);
    $("#psychograph_similarity_merge").prop("checked", settings.similarity.mergeDuplicates);
    $("#psychograph_timeline_auto_extract").prop("checked", settings.timeline.autoExtract);
    $("#psychograph_timeline_include_hidden").prop("checked", settings.timeline.includeHidden);
    $("#psychograph_timeline_inject_enabled").prop("checked", settings.timeline.injectEnabled);
    $("#psychograph_timeline_inject_limit").val(settings.timeline.injectLimit);
    for (const key of KNOWLEDGE_KEYS) {
        $(`#psychograph_${key}_auto_extract`).prop("checked", settings.knowledge[key].autoExtract);
        $(`#psychograph_${key}_include_hidden`).prop("checked", settings.knowledge[key].includeHidden);
        $(`#psychograph_${key}_inject_enabled`).prop("checked", settings.knowledge[key].injectEnabled);
    }
    renderCogneeChatSection();

    for (const { key, id } of STATE_AREAS) {
        $(`#psychograph_state_${id}_enabled`).prop("checked", settings.state.areas[key].enabled);
    }

    renderChatState();
}

// Reflects the CURRENT chat's state (target + slots), so this runs both on
// initial load and on CHAT_CHANGED (see bindChatEvents) — otherwise the
// panel would keep showing whatever chat was open when the extension
// first loaded.
export function renderChatState() {
    const chatState = ensureChatState();
    $("#psychograph_state_target").val(chatState.target);
    $("#psychograph_timeline").val(chatState.timeline);
    renderSheetHeader();

    for (const { key, id } of STATE_AREAS) {
        const slots = chatState.areas[key].slots;
        for (const slot of AREA_SLOT_CONFIGS[key].slots) {
            $(`#psychograph_state_${id}_slot_${slot}`).val(slots[slot]);
        }
    }
}

export function bindSettingsEvents() {
    $("#psychograph_enabled").on("change", function () {
        ensureSettings().enabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_connection_profile").on("change", function () {
        ensureSettings().connectionProfile = String($(this).val());
        shownConfigWarnings.clear();
        saveSettingsDebounced();
    });

    for (const [field, id] of [
        ["baseUrl", "base_url"],
        ["apiKey", "api_key"],
        ["rerankModel", "rerank_model"],
        ["embeddingModel", "embedding_model"],
    ]) {
        $(`#psychograph_similarity_${id}`).on("input", function () {
            ensureSettings().similarity[field] = String($(this).val()).trim();
            saveSettingsDebounced();
        });
    }

    $("#psychograph_similarity_threshold").on("input", function () {
        ensureSettings().similarity.duplicateThreshold = Math.min(1, Math.max(0, Number($(this).val()) || 0));
        saveSettingsDebounced();
    });

    $("#psychograph_similarity_merge").on("change", function () {
        ensureSettings().similarity.mergeDuplicates = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_similarity_test").on("click", testSimilarityService);

    $("#psychograph_parallel_requests").on("input", function () {
        ensureSettings().parallelRequests = Math.min(64, Math.max(1, Number($(this).val()) || 1));
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_base_url").on("input", function () {
        ensureSettings().cognee.baseUrl = String($(this).val());
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_api_key").on("input", function () {
        ensureSettings().cognee.apiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_enabled").on("change", function () {
        ensureSettings().cognee.enabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_recall_enabled").on("change", function () {
        ensureSettings().cognee.recallEnabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_cognee_chat_id_set").on("click", function () {
        const value = String($("#psychograph_cognee_chat_id_input").val()).trim();
        if (!value) {
            return;
        }
        writeCogneeChatId(value);
        $("#psychograph_cognee_chat_id_input").val("");
        renderCogneeChatSection();
    });

    $("#psychograph_cognee_chat_id_regenerate").on("click", async function () {
        const context = getContext();
        const confirmed = await context.callGenericPopup(
            "Regenerate this chat's Cognee id? Future messages go to a new dataset; anything already sent stays under the old one.",
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        writeCogneeChatId(crypto.randomUUID());
        renderCogneeChatSection();
    });

    $("#psychograph_cognee_backfill").on("click", backfillChatHistoryToCognee);

    $("#psychograph_timeline").on("input", function () {
        ensureChatState().timeline = String($(this).val());
        renderSheetHeader();
        getContext().saveMetadataDebounced();
    });

    $("#psychograph_timeline_auto_extract").on("change", function () {
        ensureSettings().timeline.autoExtract = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_timeline_include_hidden").on("change", function () {
        ensureSettings().timeline.includeHidden = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_timeline_inject_enabled").on("change", function () {
        ensureSettings().timeline.injectEnabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#psychograph_timeline_inject_limit").on("input", function () {
        ensureSettings().timeline.injectLimit = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });

    for (const key of KNOWLEDGE_KEYS) {
        $(`#psychograph_${key}_auto_extract`).on("change", function () {
            ensureSettings().knowledge[key].autoExtract = $(this).prop("checked");
            saveSettingsDebounced();
        });

        $(`#psychograph_${key}_include_hidden`).on("change", function () {
            ensureSettings().knowledge[key].includeHidden = $(this).prop("checked");
            saveSettingsDebounced();
        });

        $(`#psychograph_${key}_inject_enabled`).on("change", function () {
            ensureSettings().knowledge[key].injectEnabled = $(this).prop("checked");
            saveSettingsDebounced();
        });

    }

    $("#psychograph_timeline_build").on("click", buildTimeline);

    $("#psychograph_timeline_clear").on("click", async function () {
        const context = getContext();
        const confirmed = await context.callGenericPopup(
            "Clear this chat's timeline? The entries only exist here.",
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        captureUndoSnapshot("clearing the timeline");
        writeTimeline("");
    });

    $("#psychograph_state_target").on("change", function () {
        ensureChatState().target = String($(this).val());
        renderSheetHeader();
        getContext().saveMetadataDebounced();
    });

    for (const { key, id } of STATE_AREAS) {
        $(`#psychograph_state_${id}_enabled`).on("change", function () {
            ensureSettings().state.areas[key].enabled = $(this).prop("checked");
            saveSettingsDebounced();
        });

        for (const slot of AREA_SLOT_CONFIGS[key].slots) {
            $(`#psychograph_state_${id}_slot_${slot}`).on("input", function () {
                ensureChatState().areas[key].slots[slot] = String($(this).val());
                getContext().saveMetadataDebounced();
            });
        }
    }

    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, populateConnectionProfiles);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, populateConnectionProfiles);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, populateConnectionProfiles);
}

export function renderCogneeChatSection() {
    const id = readCogneeChatId();
    $("#psychograph_cognee_chat_id").text(id || "not set yet");
    $("#psychograph_cognee_chat_dataset").text(id ? `psychograph-chat-${id}` : "—");
}
