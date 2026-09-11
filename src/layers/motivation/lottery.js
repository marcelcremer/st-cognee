import { getContext } from "../../sillytavern.js";
import { ensureChatState } from "../../chat-state.js";
import { renderMotivationRoll } from "../../ui/sheet.js";
import { MOTIVATION_CONTINUATIONS, MOTIVATION_DRIVERS, findContinuation, findDriver } from "./drivers.js";

export function readMotivationRoll() {
    return ensureChatState().motivation;
}

function drawFrom(options, exclude) {
    const pool = options.filter((option) => option.key !== exclude);
    return pool[Math.floor(Math.random() * pool.length)].key;
}

// The driver just played is out of the pool: an unweighted draw over eight
// options repeats often enough that the mechanic stops reading as a lottery.
export function rollMotivation() {
    const motivation = readMotivationRoll();
    motivation.driver = drawFrom(MOTIVATION_DRIVERS, motivation.driver);
    motivation.continuation = drawFrom(MOTIVATION_CONTINUATIONS, null);
    getContext().saveMetadataDebounced();
    renderMotivationRoll();
    return motivation;
}

export function nextMotivationRoll() {
    const motivation = readMotivationRoll();
    if (motivation.locked && findDriver(motivation.driver) && findContinuation(motivation.continuation)) {
        return motivation;
    }
    return rollMotivation();
}

export function readMotivationGoal() {
    return readMotivationRoll().goal;
}

export function writeMotivationGoal(field, value) {
    readMotivationGoal()[field] = value;
    getContext().saveMetadataDebounced();
}

export function writeMotivationSelection(field, key) {
    readMotivationRoll()[field] = key;
    getContext().saveMetadataDebounced();
}

export function writeMotivationLock(locked) {
    readMotivationRoll().locked = locked;
    getContext().saveMetadataDebounced();
}
