// "|" ends a slash command, so a value carrying one would truncate the command
// it is passed to and run whatever followed as a command of its own. Every
// value that reaches executeSlashCommandsWithOptions as an argument goes
// through here first.
export function sanitizeStscriptValue(value) {
    return String(value).replace(/[|\r\n]+/g, " ").trim();
}
