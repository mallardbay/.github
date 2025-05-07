import { isBeginningOfCycle } from "../helpers";

const validDates = [
    "2025-05-05",
    "2025-06-02",
    "2025-06-30",
    "2025-07-28",
    "2025-08-25",
    "2025-09-22",
    "2025-10-20",
    "2025-11-17",
    "2025-12-15",
    "2026-01-12",
    "2026-02-09",
    "2026-03-09",
];

const invalidDates = [
    "2025-05-12",
    "2025-06-09",
    "2025-07-01",
    "2025-07-07",
    "2025-08-04",
    "2025-10-06",
    "2025-11-10",
    "2026-03-10",
];

describe("isEvery4WeeksFromMay5", () => {
    test.each(validDates)(`✅ should return TRUE for %s`, (dateStr) => {
        const date = new Date(dateStr);
        const result = isBeginningOfCycle(date);
        console.log(`Test: ${dateStr} → expected: true, got: ${result}`);
        expect(result).toBe(true);
    });

    test.each(invalidDates)(`❌ should return FALSE for %s`, (dateStr) => {
        const date = new Date(dateStr);
        const result = isBeginningOfCycle(date);
        console.log(`Test: ${dateStr} → expected: false, got: ${result}`);
        expect(result).toBe(false);
    });
});
