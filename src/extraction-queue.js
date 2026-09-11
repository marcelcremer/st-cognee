import { renderExtractionActivity } from "./ui/toolbar.js";

// One FIFO lane per layer, running in parallel with each other. Order matters
// inside a lane and nowhere else: every pass reads the slot values or the entry
// list as they stand and writes them back, so two messages of one layer must
// not overlap. One queue across all layers instead would keep a single request
// in flight, where the backend batches several and refills its own queue
// without a round trip - so the lanes hand it as many calls as the ordering
// allows, as early as it allows.
const lanes = new Map();

export const STATE_LANE = "state";

export const TIMELINE_LANE = "timeline";

export function knowledgeLane(layer) {
    return `knowledge:${layer.id}`;
}

let pending = 0;

export function runInLane(laneId, task) {
    pending += 1;
    renderExtractionActivity(pending);

    const previous = lanes.get(laneId) ?? Promise.resolve();
    const next = previous.then(task).finally(() => {
        pending -= 1;
        renderExtractionActivity(pending);
    });

    // The lane's tail must not carry a rejection, or every later job in it
    // would be skipped rather than run.
    lanes.set(laneId, next.catch(() => {}));
    return next;
}
