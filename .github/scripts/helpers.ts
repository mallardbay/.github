export function isBeginningOfCycle(date: Date): boolean {
    // Beggining of each cycle
    const anchor = new Date("2025-05-05T00:00:00Z");

    // Must be Monday
    if (date.getUTCDay() !== 1) return false;

    const diffMs = date.getTime() - anchor.getTime();
    const diffWeeks = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7));

    return diffWeeks >= 0 && diffWeeks % 4 === 0;
}

function isMonday(date: Date): boolean {
    return date.getDay() === 1;
}

// Slack configuration
export const SLACK_CHANNEL = "#dev-github-actions";
