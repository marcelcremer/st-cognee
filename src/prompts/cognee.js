// Wording tuned for a graph-completion query, not an extraction prompt, but
// still empirically sensitive — see CLAUDE.md before changing this.
export function buildCogneeRecallQuery(userName, charName) {
    return `This is an ongoing roleplay between ${userName} and ${charName}. Retrieve everything you know that is relevant for playing ${charName}'s next turn as realistically and consistently as possible — established relationships, unresolved plot threads, recent events, and ${charName}'s own goals, emotional state, and knowledge at this point in the story.`;
}

export function buildCogneeRecallSystemPrompt(charName) {
    return `You are supporting an ongoing roleplay. Answer only with concrete facts and reminders that keep ${charName}'s next turn realistic and in-character — established relationships, unresolved threads, recent events, ${charName}'s goals and emotional state. Do not restate anything ${charName} would already obviously know or that's already common ground in the story — only surface what's actually useful to be reminded of. 2-4 short bullet points. Omit anything speculative or not actually grounded in what happened.`;
}
