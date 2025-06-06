import { graphql } from "@octokit/graphql";
import { createCanvas } from "canvas";
import fs from "fs";
import { WebClient } from "@slack/web-api";

const SLACK_CHANNEL_ID = "C07A6US3QAH"; // #dev-team-metrics
const QUERIES = getQueries();

main();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Converts a string to camelCase
 * Example: "Due Date" -> "dueDate"
 */
function toCamelCase(str: string): string {
    return str
        .toLowerCase()
        .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase());
}

/**
 * Logs a message with an emoji prefix
 */
function log(emoji: string, message: string, data?: any) {
    if (data) {
        console.log(`${emoji} ${message}`, data);
    } else {
        console.log(`${emoji} ${message}`);
    }
}

/**
 * Creates a GraphQL client with authentication
 */
function createGraphQLClient() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("❌ Missing GITHUB_TOKEN env variable.");
    }

    return graphql.defaults({
        headers: {
            authorization: `token ${token}`,
        },
    });
}

/**
 * Aggregates issues by author and sums their sizes
 */
function aggregateIssuesByAuthor(
    issues: ClosedIssue[]
): Record<string, AuthorStats> {
    const authorStats: Record<string, AuthorStats> = {};

    issues.forEach((issue) => {
        const author = issue.author?.login ?? "unknown";
        // Parse size to number, defaulting to 0 if not a valid number
        const size =
            typeof issue.projectData?.size === "string"
                ? parseInt(issue.projectData.size, 10) || 0
                : (issue.projectData?.size as number) ?? 0;

        if (!authorStats[author]) {
            authorStats[author] = {
                totalSize: 0,
                issues: [],
            };
        }

        authorStats[author].totalSize += size;
        authorStats[author].issues.push(issue);
    });

    // Sort authors by total size
    return Object.fromEntries(
        Object.entries(authorStats).sort(
            ([, a], [, b]) => b.totalSize - a.totalSize
        )
    );
}

// ============================================================================
// Visualization Functions
// ============================================================================

/**
 * Generates a colorful terminal bar chart with consistent author colors, using horizontal bars
 */
function generateTerminalBarChart(
    authorStats: Record<string, AuthorStats>
): string {
    const authors = Object.entries(authorStats);
    const data = authors.map(([, stats]) => stats.totalSize);
    const labels = authors.map(([author]) => author);
    const maxVal = Math.max(...data);
    const barWidth = 40; // Maximum width of the bars

    // ANSI color codes - user custom palette
    const COLORS = [
        "\x1b[38;2;155;38;151m", // #9B2697
        "\x1b[38;2;35;41;167m", // #2329A7
        "\x1b[38;2;62;220;129m", // #3EDC81
        "\x1b[38;2;24;166;179m", // #18A6B3
        "\x1b[38;2;155;67;228m", // #9B43E4
    ];
    const RESET = "\x1b[0m";

    // Assign a color to each author based on a hash of their name
    function getColor(author: string) {
        let hash = 0;
        for (let i = 0; i < author.length; i++) {
            hash = author.charCodeAt(i) + ((hash << 5) - hash);
        }
        return COLORS[Math.abs(hash) % COLORS.length];
    }

    // Format the author name (truncate if too long)
    function formatName(name: string, width: number) {
        if (name.length > width) {
            return name.slice(0, width - 3) + "...";
        }
        return name.padEnd(width);
    }

    const nameWidth = 15;
    const valueWidth = 6;
    const totalWidth = 2 + nameWidth + 2 + barWidth + 2 + valueWidth + 2; // for borders and spaces

    // Top border
    let chart = "┌" + "─".repeat(totalWidth - 2) + "┐\n";

    // For each author
    for (let i = 0; i < authors.length; i++) {
        const color = getColor(labels[i]);
        const value = data[i];
        const barLength = Math.round((value / maxVal) * barWidth);
        let name = formatName(labels[i], nameWidth);
        const bar = "█".repeat(barLength).padEnd(barWidth);
        const valueStr = String(value).padStart(valueWidth);
        chart += `│ ${color}${name}${RESET}  ${color}${bar}${RESET}  ${color}${valueStr}${RESET} │\n`;
        // Add a blank line (with borders) between bars, except after the last bar
        if (i < authors.length - 1) {
            chart += "│" + " ".repeat(totalWidth - 2) + "│\n";
        }
    }

    // Bottom border
    chart += "└" + "─".repeat(totalWidth - 2) + "┘\n";

    return chart;
}

/**
 * Generates a colorful bar chart image
 */
function generateImageChart(
    authorStats: Record<string, AuthorStats>,
    outputPath: string
): void {
    const authors = Object.entries(authorStats);
    const data = authors.map(([, stats]) => stats.totalSize);
    const labels = authors.map(([author]) => author);

    // Layout constants
    const rowHeight = 60;
    const nameWidth = 220;
    const valueWidth = 60;
    const barMaxWidth = 400;
    const barHeight = 32;
    const barGap = 18;
    const padding = 32;
    const borderWidth = 2;
    const width = nameWidth + barMaxWidth + valueWidth + padding * 2;
    const height = authors.length * rowHeight + padding * 2;

    // Custom color palette (same as terminal)
    const COLORS = ["#9B2697", "#2329A7", "#3EDC81", "#18A6B3", "#9B43E4"];

    function getColor(author: string) {
        let hash = 0;
        for (let i = 0; i < author.length; i++) {
            hash = author.charCodeAt(i) + ((hash << 5) - hash);
        }
        return COLORS[Math.abs(hash) % COLORS.length];
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Background: #21222D
    ctx.fillStyle = "#21222D";
    ctx.fillRect(0, 0, width, height);

    // Border
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = borderWidth;
    ctx.strokeRect(
        borderWidth,
        borderWidth,
        width - borderWidth * 2,
        height - borderWidth * 2
    );

    // Draw each row (author)
    const maxValue = Math.max(...data);
    for (let i = 0; i < authors.length; i++) {
        const y = padding + i * rowHeight + (rowHeight - barHeight) / 2;
        const color = getColor(labels[i]);
        const value = data[i];
        const barLength = Math.round((value / maxValue) * barMaxWidth);
        let name = labels[i];
        if (name.length > 16) name = name.slice(0, 15) + "…";

        // Name (left)
        ctx.font = "bold 26px Menlo, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = color;
        ctx.fillText(name, padding, y + barHeight / 2);

        // Bar (middle)
        ctx.fillStyle = color;
        ctx.fillRect(padding + nameWidth, y, barLength, barHeight);

        // Value (right)
        ctx.font = "bold 26px Menlo, monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillStyle = color;
        ctx.fillText(
            String(value),
            padding + nameWidth + barMaxWidth + valueWidth - 10,
            y + barHeight / 2
        );
    }

    // Save the image
    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(outputPath, buffer);
}

// ============================================================================
// Slack Integration
// ============================================================================

/**
 * Posts an image to a Slack channel
 */
async function postImageToSlack(
    imagePath: string,
    channelId: string,
    topPerformerGitHub?: string
): Promise<void> {
    // Map GitHub usernames to Slack user IDs (fill in the values)
    const githubToSlackHandles: Record<string, string> = {
        izzyromero134: "U07TG88H9A9",
        AdamRisberg: "U05S8QBTWRJ",
        kevinbror: "U06QGDV14P4",
        mfrr1118: "U05R32XT3L2",
    };

    const token = process.env.SLACK_TOKEN;
    if (!token) {
        throw new Error("❌ Missing SLACK_TOKEN env variable.");
    }

    const web = new WebClient(token);

    // Prepare congratulatory message
    let initialComment = "📊 Weekly Story Points \n\n";
    if (topPerformerGitHub && githubToSlackHandles[topPerformerGitHub]) {
        const slackId = githubToSlackHandles[topPerformerGitHub];
        initialComment += `\n:trophy: <@${slackId}> is this week's top performer! 🎉`;
    }

    try {
        const result = await web.files.uploadV2({
            channel_id: channelId,
            file: fs.createReadStream(imagePath),
            filename: "weekly-story-points-by-developer.png",
            title: "Weekly Story Points by Developer",
            initial_comment: initialComment,
        });

        if (!result.ok) {
            throw new Error(`Failed to upload image to Slack: ${result.error}`);
        }

        log("✅", "Image posted to Slack successfully");
    } catch (error) {
        log("❌", "Error posting to Slack:", error);
        throw error;
    }
}

// ============================================================================
// GitHub API Functions
// ============================================================================

/**
 * Fetches project data for a specific issue in a repository
 */
async function fetchProjectData(
    issueNumber: number,
    repo: string
): Promise<ProjectData> {
    const graphqlWithAuth = createGraphQLClient();
    const owner = "mallardbay";

    log("🔍", `Fetching project data for issue #${issueNumber} in ${repo}`);

    try {
        const result = (await graphqlWithAuth(QUERIES.projectData, {
            owner,
            repo,
            issueNumber,
        })) as any;

        const items = result.repository.issue.projectItems.nodes;
        if (items.length === 0) {
            throw new Error("No project items found for this issue");
        }

        // Take the first project item
        const item = items[0];
        const projectData: ProjectData = {
            title: item.project.title,
            number: item.project.number,
        };

        // Add all fields as key-value pairs
        item.fieldValues.nodes.forEach((field: any) => {
            const fieldName = field.field?.name ?? "Unknown";
            let value: string | number | null = null;

            if ("text" in field) {
                value = field.text;
            } else if ("name" in field) {
                value = field.name;
            } else if ("date" in field) {
                value = field.date;
            } else if ("number" in field) {
                value = field.number;
            }

            if (value !== null) {
                projectData[toCamelCase(fieldName)] = value;
            }
        });

        log("✅", `Found project data for issue #${issueNumber}`);
        return projectData;
    } catch (err: any) {
        if (err.message?.includes("Could not resolve to an Issue")) {
            throw new Error(
                `Issue #${issueNumber} not found in repository ${repo}`
            );
        }
        throw err;
    }
}

/**
 * Fetches all recently closed issues from the mallardbay organization
 * and enriches them with project data if available
 */
async function fetchRecentlyClosedIssues(
    days: number = 7
): Promise<ClosedIssue[]> {
    const graphqlWithAuth = createGraphQLClient();
    const owner = "mallardbay";
    const since = new Date();
    since.setDate(since.getDate() - days);

    log("🔍", `Fetching issues closed in the last ${days} days`);

    try {
        const result = (await graphqlWithAuth(QUERIES.recentlyClosedIssues, {
            owner,
            since: since.toISOString(),
        })) as any;

        const issues: ClosedIssue[] = [];
        let totalIssues = 0;
        let issuesWithProjectData = 0;

        for (const repo of result.organization.repositories.nodes) {
            for (const issue of repo.issues.nodes) {
                totalIssues++;
                const enrichedIssue: ClosedIssue = {
                    ...issue,
                    repository: {
                        name: repo.name,
                    },
                };

                try {
                    // Try to fetch project data for this issue
                    enrichedIssue.projectData = await fetchProjectData(
                        issue.number,
                        repo.name
                    );
                    issuesWithProjectData++;
                } catch (err: any) {
                    // Only log if it's not a "not found" error
                    if (
                        !err.message?.includes("Could not resolve to an Issue")
                    ) {
                        log(
                            "⚠️",
                            `Error fetching project data for issue #${issue.number} in ${repo.name}:`,
                            err.message
                        );
                    }
                }

                issues.push(enrichedIssue);
            }
        }

        log(
            "📊",
            `Found ${totalIssues} closed issues, ${issuesWithProjectData} with project data`
        );
        return issues.sort(
            (a, b) =>
                new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime()
        );
    } catch (err: any) {
        log("❌", "Error fetching recently closed issues:", err);
        throw err;
    }
}

async function postMetrics() {
    log("🚀", "Starting to fetch recently closed issues...");
    const closedIssues = await fetchRecentlyClosedIssues();
    log("✨", "Successfully fetched all issues!");

    const authorStats = aggregateIssuesByAuthor(closedIssues);

    log("📊", "Author statistics:");
    Object.entries(authorStats).forEach(([author, stats]) => {
        log("👤", `${author}:`, {
            totalSize: stats.totalSize,
            issueCount: stats.issues.length,
            issues: stats.issues.map((issue) => ({
                number: issue.number,
                title: issue.title,
                size: issue.projectData?.size ?? 0,
            })),
        });
    });

    // Generate terminal bar chart
    log("📈", "Generating terminal bar chart...");
    console.log(generateTerminalBarChart(authorStats));

    // Generate image chart
    log("🖼️", "Generating image chart...");
    const imagePath = "author-stats.png";
    generateImageChart(authorStats, imagePath);
    log("✅", "Chart saved as author-stats.png");

    // Find the top performer (first in sorted authorStats)
    const topPerformerGitHub = Object.keys(authorStats)[0];

    // Post to Slack if SLACK_TOKEN and SLACK_CHANNEL are set
    await postImageToSlack(imagePath, SLACK_CHANNEL_ID, topPerformerGitHub);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    try {
        await postMetrics();
    } catch (err) {
        log("❌", "Fatal error:", err);
        process.exit(1);
    }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Represents the project data for an issue, including custom fields
 */
interface ProjectData {
    title: string;
    number: number;
    [key: string]: string | number | null;
}

/**
 * Represents a closed issue with optional project data
 */
interface ClosedIssue {
    title: string;
    number: number;
    repository: {
        name: string;
    };
    closedAt: string;
    url: string;
    projectData?: ProjectData;
    author?: {
        login: string;
    };
}

/**
 * Represents aggregated data for an author
 */
interface AuthorStats {
    totalSize: number;
    issues: ClosedIssue[];
}

// ============================================================================
// GraphQL Queries
// ============================================================================

function getQueries() {
    return {
        recentlyClosedIssues: `
      query($owner: String!, $since: DateTime!) {
        organization(login: $owner) {
          repositories(first: 100) {
            nodes {
              name
              issues(first: 50, states: [CLOSED], filterBy: {since: $since}) {
                nodes {
                  title
                  number
                  closedAt
                  url
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    `,

        projectData: `
      query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            title
            projectItems(first: 10) {
              nodes {
                project {
                  title
                  number
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue {
                      field {
                        ... on ProjectV2FieldCommon {
                          id
                          name
                        }
                      }
                      text
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      field {
                        ... on ProjectV2FieldCommon {
                          id
                          name
                        }
                      }
                      name
                    }
                    ... on ProjectV2ItemFieldDateValue {
                      field {
                        ... on ProjectV2FieldCommon {
                          id
                          name
                        }
                      }
                      date
                    }
                    ... on ProjectV2ItemFieldNumberValue {
                      field {
                        ... on ProjectV2FieldCommon {
                          id
                          name
                        }
                      }
                      number
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    };
}
