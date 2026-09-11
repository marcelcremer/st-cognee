import { extension_settings } from "./sillytavern.js";
import { extensionName } from "./constants.js";
import { KNOWLEDGE_KEYS } from "./layers/knowledge/layers.js";
import { STATE_AREAS } from "./layers/state/areas.js";

const defaultSettings = {
    enabled: true,
    connectionProfile: "",
    parallelRequests: 4,
    similarity: {
        baseUrl: "",
        apiKey: "",
        rerankModel: "",
        embeddingModel: "",
        // Which of the two spellings this server answered on, so the working
        // one is not re-discovered on every call.
        rerankPath: "",
        duplicateThreshold: 0.5,
        mergeDuplicates: true,
    },
    cognee: {
        baseUrl: "",
        apiKey: "",
        enabled: false,
        recallEnabled: false,
    },
    state: {
        areas: Object.fromEntries(STATE_AREAS.map(({ key }) => [key, { enabled: true }])),
    },
    knowledge: Object.fromEntries(KNOWLEDGE_KEYS.map((key) => [key, {
        autoExtract: true,
        includeHidden: true,
        injectEnabled: true,
    }])),
    motivation: {
        enabled: true,
    },
    timeline: {
        autoExtract: true,
        includeHidden: true,
        injectEnabled: true,
        injectLimit: 0,
    },
};

// Fills in what is missing without replacing the object. Rebuilding it on every
// call handed out a fresh copy each time, so anything holding a reference to a
// settings branch across an await was writing into a discarded object — which
// is how the rerank path was stored and then reported as empty.
function fillDefaults(target, defaults) {
    const filled = target ?? {};
    for (const [key, value] of Object.entries(defaults)) {
        if (filled[key] === undefined) {
            filled[key] = structuredClone(value);
        }
    }
    return filled;
}

export function ensureSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    settings.cognee = fillDefaults(settings.cognee, defaultSettings.cognee);
    settings.similarity = fillDefaults(settings.similarity, defaultSettings.similarity);
    settings.timeline = fillDefaults(settings.timeline, defaultSettings.timeline);
    settings.motivation = fillDefaults(settings.motivation, defaultSettings.motivation);
    settings.knowledge = settings.knowledge || {};
    for (const key of KNOWLEDGE_KEYS) {
        // The trigger layer predates the other two and had settings of its own.
        if (key === "triggers" && settings.triggers) {
            settings.knowledge.triggers = fillDefaults(settings.knowledge.triggers, settings.triggers);
        }
        settings.knowledge[key] = fillDefaults(settings.knowledge[key], defaultSettings.knowledge[key]);
    }
    delete settings.triggers;
    settings.state = settings.state || {};
    settings.state.areas = settings.state.areas || {};
    for (const { key } of STATE_AREAS) {
        settings.state.areas[key] = fillDefaults(settings.state.areas[key], defaultSettings.state.areas[key]);
    }
    if (settings.enabled === undefined) {
        settings.enabled = defaultSettings.enabled;
    }
    if (settings.connectionProfile === undefined) {
        settings.connectionProfile = defaultSettings.connectionProfile;
    }
    if (!Number.isInteger(settings.parallelRequests) || settings.parallelRequests < 1) {
        settings.parallelRequests = defaultSettings.parallelRequests;
    }

    return settings;
}
