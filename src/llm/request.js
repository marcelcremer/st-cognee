import { ConnectionManagerRequestService } from "../sillytavern.js";
import { ensureSettings } from "../settings.js";

function parseJsonResponse(content) {
    // The chat-completion path JSON.parses the response itself once a schema
    // is in the request, so there is nothing left to parse here.
    if (content && typeof content === "object") {
        return content;
    }

    const text = String(content).trim();
    try {
        return JSON.parse(text);
    } catch (error) {
        const withoutCodeFence = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
        const match = withoutCodeFence.match(/\{[\s\S]*\}/);
        if (!match) {
            throw error;
        }
        return JSON.parse(match[0]);
    }
}

// Extraction runs on every turn, so a misconfiguration would stack one toast
// per message without this.
export const shownConfigWarnings = new Set();

export function warnOnce(key, message) {
    if (shownConfigWarnings.has(key)) {
        return;
    }
    shownConfigWarnings.add(key);
    toastr.warning(message, "Psychograph");
}

export const NO_PROFILE_WARNING = "No connection profile selected for Psychograph — state extraction stays off until you pick one.";

// Text completion is the picky mode: SillyTavern only forwards json_schema to
// these two, while every chat-completion source gets a response_format built
// for it. See docs/sillytavern-ui-notes.md.
const SCHEMA_ENFORCING_APIS = new Set(["tabby", "llamacpp"]);

function warnIfSchemaEnforcementUnsupported(profile) {
    if (profile.mode !== "tc") {
        return;
    }

    const api = String(profile.api ?? "").toLowerCase();
    if (api && !SCHEMA_ENFORCING_APIS.has(api)) {
        warnOnce(
            `schema:${profile.id}`,
            `SillyTavern doesn't forward the JSON schema to ${api}, only to TabbyAPI and llama.cpp. Extraction falls back to the prompt alone, which small models follow less reliably.`,
        );
    }
}

function resolveProfile(profileId) {
    let profile = null;
    try {
        profile = ConnectionManagerRequestService.getProfile(profileId);
    } catch (error) {
        console.error("[Psychograph] Connection profile lookup failed:", error);
    }

    if (!profile) {
        warnOnce(`profile:${profileId}`, "The connection profile Psychograph is configured to use no longer exists. Pick one in the Psychograph settings.");
        return null;
    }

    warnIfSchemaEnforcementUnsupported(profile);
    return profile;
}

// One window across every backfill, not one per layer: the three layers run at
// the same time, so a per-layer limit of four means twelve requests in flight
// and the number no longer describes what the backend sees. Interactive calls
// bypass it, or chatting would queue behind bulk work.
function createRequestPool(getLimit) {
    let active = 0;
    const waiting = [];

    return async function run(task) {
        while (active >= Math.max(1, getLimit())) {
            await new Promise((resolve) => waiting.push(resolve));
        }

        active += 1;
        try {
            return await task();
        } finally {
            active -= 1;
            waiting.shift()?.();
        }
    };
}

export const backfillPool = createRequestPool(() => ensureSettings().parallelRequests);

export async function sendJsonSchemaRequest(profileId, schemaName, schema, prompt, maxTokens) {
    const profile = resolveProfile(profileId);
    if (!profile) {
        throw new Error(`Connection profile "${profileId}" is unavailable.`);
    }

    // Both modes read the same field name but not the same shape: text
    // completion takes the bare schema (as the Tabby settings field does),
    // chat completion the wrapper its backend translates per provider.
    const overridePayload = profile.mode === "tc"
        ? { json_schema: schema }
        : { json_schema: { name: schemaName, strict: true, value: schema } };

    const response = await ConnectionManagerRequestService.sendRequest(
        profileId,
        prompt,
        maxTokens,
        {},
        overridePayload,
    );

    return parseJsonResponse(response.content);
}
