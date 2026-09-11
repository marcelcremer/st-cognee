// The wording is the repo owner's own glossary and lottery text, turned
// imperative. Like every prompt text in this repo it is tuned against their
// model, not derived - see CLAUDE.md before rephrasing any of it.
export const MOTIVATION_DRIVERS = [
    {
        key: "calculated",
        label: "Calculated",
        instruction: "Weigh what this actually costs {{char}} and what it gains them, and act on the result.",
    },
    {
        key: "identity",
        label: "Identity",
        instruction: "Nothing is being traded here. {{char}} acts because this is who they are.",
    },
    {
        key: "procedural",
        label: "Procedural",
        instruction: "A trained habit or role fires. {{char}} does not deliberate - the motion is already underway.",
    },
    {
        key: "affective",
        label: "Affective",
        instruction: "The feeling moves first. {{char}} acts on it before anything gets evaluated.",
    },
    {
        key: "relational",
        label: "Relational",
        instruction: "Whatever {{char}} does, they do it for a bond to someone - not for their own gain.",
    },
    {
        key: "normative",
        label: "Normative",
        instruction: "A principle carries this turn. {{char}} follows it whether or not it matches what they feel like doing.",
    },
    {
        key: "mimetic",
        label: "Mimetic/Contagion",
        instruction: "{{char}} catches someone else's mood or state and carries it, without noticing it happen.",
    },
    {
        key: "avoidant",
        label: "Avoidant/Defensive",
        instruction: "{{char}} pulls back or deflects to make the discomfort smaller. Nothing gets weighed.",
    },
];

// Each level is an operation on the first thing that comes to mind, not a
// verdict on the finished text: asked to judge how obvious its own plan is,
// the model finds a reason to call it whatever was requested. The wording also
// stays within a single pass, since the roleplay prompt these ship next to
// forbids drafting a second version.
export const MOTIVATION_CONTINUATIONS = [
    {
        key: "expected",
        label: "the expected one",
        instruction: "Write the continuation that comes to mind first. It is the right one this turn.",
    },
    {
        key: "onePast",
        label: "one past the obvious",
        instruction: "The continuation that comes to mind first is not the one to write. Go one step further and write that one.",
    },
    {
        key: "notLikeliest",
        label: "not the likeliest",
        instruction: "The likeliest continuation is out. Write another one that follows from the scene just as believably.",
    },
    {
        key: "unusual",
        label: "unusual but coherent",
        instruction: "Pass over the obvious continuations. Write an unusual one, and make it follow from what has happened anyway.",
    },
    {
        key: "farDown",
        label: "far down the list",
        instruction: "Write one of the continuations that would occur to you last. It still has to be believable for {{char}} in this scene.",
    },
];

const MOTIVATION_INJECT_HEADING = "## How to play this turn";

const DRIVER_CLOSER = "Play it. Don't narrate it, don't name it, and don't have {{char}} explain themselves.";

// Deliberately ahead of the driver block in the same inject: the goal is a
// standing thread, the driver is what this turn runs on, and the model weighs
// the later instruction more heavily.
export function buildGoalInject(goal) {
    if (!goal) {
        return "";
    }

    return [
        "## Current goal",
        `{{char}} is quietly pursuing: ${goal}`,
        "This is one thread among many — do not let it override {{char}}'s immediate reactions, other drivers, or the scene's actual demands. It's influence subtle and unconscious.",
    ].join("\n");
}

export function findDriver(key) {
    return MOTIVATION_DRIVERS.find((driver) => driver.key === key) ?? null;
}

export function findContinuation(key) {
    return MOTIVATION_CONTINUATIONS.find((continuation) => continuation.key === key) ?? null;
}

export function buildMotivationInject(roll) {
    const driver = findDriver(roll?.driver);
    const continuation = findContinuation(roll?.continuation);
    if (!driver || !continuation) {
        return "";
    }

    return [
        MOTIVATION_INJECT_HEADING,
        "",
        `### Driver: ${driver.label}`,
        driver.instruction,
        DRIVER_CLOSER,
        "",
        `### Continuation: ${continuation.label}`,
        continuation.instruction,
    ].join("\n");
}
