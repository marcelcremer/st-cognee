import { saveSettingsDebounced } from "../sillytavern.js";
import { ensureSettings } from "../settings.js";

// Rerank and embeddings go straight to the user's own server: SillyTavern has
// no route for either, and its one vector endpoint applies the threshold on the
// server and returns no scores, which is exactly what makes a threshold
// impossible to calibrate.
// A page served over HTTPS cannot call a plain-HTTP host: the browser blocks it
// as mixed content before the request leaves, and all fetch reports back is
// "Failed to fetch". localhost is exempt, browsers treat it as trustworthy.
function describeMixedContent(baseUrl) {
    try {
        const target = new URL(baseUrl);
        const isLocal = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(target.hostname);
        if (window.location.protocol === "https:" && target.protocol === "http:" && !isLocal) {
            return `${target.host} is plain HTTP and this page is HTTPS, so the browser blocks the request before it is sent. Serve it over HTTPS, or proxy it under this origin.`;
        }
    } catch (error) {
        return "The base URL is not a valid URL.";
    }
    return "";
}

async function similarityRequest(path, body) {
    const settings = ensureSettings().similarity;
    const blocked = describeMixedContent(settings.baseUrl);
    if (blocked) {
        throw new Error(blocked);
    }
    const headers = { "Content-Type": "application/json" };
    if (settings.apiKey) {
        // Two spellings, because llama.cpp reads the first and TabbyAPI the
        // second, and the servers ignore what they do not know.
        headers.Authorization = `Bearer ${settings.apiKey}`;
        headers["X-Api-Key"] = settings.apiKey;
    }

    const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${path} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
}

const RERANK_PATHS = ["/v1/rerank", "/rerank"];

// llama.cpp answers on both spellings, TabbyAPI and others on one of them, so
// the first that works is remembered rather than asked for in the settings.
export async function rerankCandidates(query, documents) {
    const settings = ensureSettings().similarity;
    const paths = settings.rerankPath ? [settings.rerankPath, ...RERANK_PATHS] : RERANK_PATHS;
    let lastError = null;

    for (const path of [...new Set(paths)]) {
        try {
            const result = await similarityRequest(path, {
                model: settings.rerankModel,
                query,
                documents,
                top_n: documents.length,
            });
            const results = result.results ?? result.data ?? [];
            if (settings.rerankPath !== path) {
                settings.rerankPath = path;
                saveSettingsDebounced();
            }
            return results
                .map((entry) => ({ index: Number(entry.index), score: Number(entry.relevance_score ?? entry.score) }))
                .filter((entry) => Number.isInteger(entry.index) && Number.isFinite(entry.score))
                .sort((a, b) => b.score - a.score);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error("No rerank endpoint answered.");
}

async function embedText(input) {
    const settings = ensureSettings().similarity;
    const result = await similarityRequest("/v1/embeddings", { model: settings.embeddingModel, input });
    const embedding = result.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
        throw new Error("The embeddings response carried no vector.");
    }
    return embedding;
}

// Reports a same/different pair of scores rather than just "it works": those
// two numbers are the first real data point for where a threshold belongs on
// this particular model.
export async function testSimilarityService() {
    const settings = ensureSettings().similarity;
    const status = $("#psychograph_similarity_status");
    if (!settings.baseUrl) {
        status.text("Set the base URL first.");
        return;
    }

    const blocked = describeMixedContent(settings.baseUrl);
    if (blocked) {
        status.text(blocked);
        return;
    }

    status.text("Testing…");
    const lines = [];

    try {
        const scores = await rerankCandidates("she goes quiet whenever she smells smoke", [
            "goes silent when there is smoke in the air",
            "keeps a spare key under the doormat",
        ]);
        const byIndex = Object.fromEntries(scores.map((entry) => [entry.index, entry.score.toFixed(4)]));
        lines.push(`rerank ${settings.rerankPath}: same ${byIndex[0]}, unrelated ${byIndex[1]}`);
    } catch (error) {
        console.error("[Psychograph] Rerank test failed:", error);
        lines.push(`rerank: ${error.message}`);
    }

    try {
        const vector = await embedText("test");
        lines.push(`embeddings: ${vector.length} dimensions`);
    } catch (error) {
        console.error("[Psychograph] Embeddings test failed:", error);
        lines.push(`embeddings: ${error.message}`);
    }

    status.text(lines.join(" · "));
}
