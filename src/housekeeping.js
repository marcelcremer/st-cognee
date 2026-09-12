import { getContext } from "./sillytavern.js";
import { isTimelineMessage } from "./messages.js";
import { ensureSettings } from "./settings.js";

// The window is computed over story messages only: a /comment note, one of
// SillyTavern's own UI messages or a bias-only /sys carries is_system for a
// reason of its own, and unhiding one would push it into the prompt.
function collectWindowRows() {
    return getContext().chat
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => isTimelineMessage(message, true));
}

export function readHousekeepingCounts() {
    const rows = collectWindowRows();
    return {
        total: rows.length,
        visible: rows.filter(({ message }) => !message.is_system).length,
    };
}

export function planHousekeeping({ unhide = true } = {}) {
    const keepVisible = ensureSettings().housekeeping.keepVisible;
    const plan = { hide: [], unhide: [] };
    if (keepVisible <= 0) {
        return plan;
    }

    const rows = collectWindowRows();
    const cutoff = Math.max(0, rows.length - keepVisible);
    rows.forEach(({ message, index }, position) => {
        if (position < cutoff) {
            if (!message.is_system) {
                plan.hide.push(index);
            }
            return;
        }
        if (unhide && message.is_system) {
            plan.unhide.push(index);
        }
    });
    return plan;
}

function toRanges(indices) {
    const ranges = [];
    for (const index of indices) {
        const last = ranges[ranges.length - 1];
        if (last && index === last.end + 1) {
            last.end = index;
            continue;
        }
        ranges.push({ start: index, end: index });
    }
    return ranges;
}

// /hide and /unhide rather than writing is_system here: they are what flips the
// flag, the message block's attribute and the saved chat in one step.
async function runRanges(command, indices) {
    const context = getContext();
    for (const { start, end } of toRanges(indices)) {
        await context.executeSlashCommandsWithOptions(`/${command} ${start}-${end}`);
    }
}

export async function applyHousekeeping(options) {
    const plan = planHousekeeping(options);
    await runRanges("hide", plan.hide);
    await runRanges("unhide", plan.unhide);
    return plan;
}
