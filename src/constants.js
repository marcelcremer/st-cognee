export const extensionName = "st-psychograph";

export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Reading a static profile is a different job from finding a delta in a story
// beat, so every prompt builder takes the mode and picks its own wording.
export const MESSAGE_MODE = "message";

export const SEED_MODE = "seed";
