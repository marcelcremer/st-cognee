import { renderExtractionActivity } from "./ui/toolbar.js";

// One FIFO lane per layer, running in parallel with each other. Order matters
// inside a lane and nowhere else: every pass reads the slot values or the entry
// list as they stand and writes them back, so two messages of one layer must
// not overlap. One queue across all layers instead would keep a single request
// in flight, which is where a batching backend's throughput comes from.
const lanes = new Map();

export const STATE_LANE = "state";

export const TIMELINE_LANE = "timeline";

export function knowledgeLane(layer) {
    return `knowledge:${layer.id}`;
}

let pending = 0;

// While a generation runs, the reply is what the reader is waiting for, so
// fewer lanes work at once. GENERATION_ENDED alone would be a bad gate - it is
// emitted from hideStopButton() behind a NOOP guard and can be missed - so the
// flag is cleared from three events and a wrong flag costs a concurrency level
// rather than stalling the queue.
const LANES_WHILE_GENERATING = 2;

let generating = false;

let active = 0;

const waiting = [];

function wakeWaiting() {
    waiting.splice(0).forEach((resolve) => resolve());
}

export function setGenerationRunning(value) {
    generating = value;
    if (!generating) {
        wakeWaiting();
    }
}

async function acquireSlot() {
    while (generating && active >= LANES_WHILE_GENERATING) {
        await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
}

function releaseSlot() {
    active -= 1;
    wakeWaiting();
}

export function runInLane(laneId, task) {
    pending += 1;
    renderExtractionActivity(pending);

    const previous = lanes.get(laneId) ?? Promise.resolve();
    const next = previous.then(async () => {
        await acquireSlot();
        try {
            return await task();
        } finally {
            releaseSlot();
        }
    }).finally(() => {
        pending -= 1;
        renderExtractionActivity(pending);
    });

    // The lane's tail must not carry a rejection, or every later job in it
    // would be skipped rather than run.
    lanes.set(laneId, next.catch(() => {}));
    return next;
}
