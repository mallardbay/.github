import fetch from "node-fetch";
import OpenAI from "openai";
import FormData from "form-data";
import { WebClient } from "@slack/web-api";
import { SLACK_CHANNEL } from "./helpers";

const githubToken: string | undefined = process.env.GITHUB_TOKEN;
const uploadcarePublicKey = process.env.UPLOADCARE_PUBLIC_KEY;
const slackToken: string | undefined = process.env.SLACK_TOKEN;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const org: string | undefined = process.env.GITHUB_ORG;

if (!githubToken) {
    console.error("❌ Missing GITHUB_TOKEN environment variable.");
    process.exit(1);
}

if (!org) {
    console.error("❌ Missing GITHUB_ORG environment variable.");
    process.exit(1);
}

if (!uploadcarePublicKey) {
    throw new Error("❌ Missing UPLOADCARE_PUBLIC_KEY");
}

if (!slackToken) {
    console.error("❌ Missing SLACK_TOKEN environment variable.");
    process.exit(1);
}

const rehostCache = new Map<string, string>(); // GitHub URL -> Uploadcare URL

main();

async function main(): Promise<void> {
    console.log("🚀 Generating grouped changelog...");
    const repos = await getRepos();

    const allContributors = new Set<string>();
    const allPRLinks: string[] = [];
    let details = "";

    for (const repo of repos) {
        const repoDetails = await processRepo(
            repo.name,
            allContributors,
            allPRLinks
        );
        if (repoDetails) details += repoDetails;
    }

    if (!details.trim()) {
        console.log("📭 No PRs merged yesterday.");
        return;
    }

    details += formatContributors(allContributors);
    details += await formatQuote();
    details += formatPRLinks(allPRLinks);

    const title = `Release Notes - Past 24 Hours`;
    const cannyEntryId = await postToCanny({ title, details });
    await postToSlack(cannyEntryId, title);
}

function mergedInLast24Hours(dateStr: string): boolean {
    const date = new Date(dateStr);
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    return diffInMs <= 24 * 60 * 60 * 1000; // 24 hours in ms
}

async function getRepos(): Promise<Array<{ name: string }>> {
    console.log("📦 Fetching repositories...");
    const res = await fetch(
        `https://api.github.com/orgs/${org}/repos?per_page=100`,
        {
            headers: { Authorization: `Bearer ${githubToken}` },
        }
    );

    if (!res.ok) {
        const text = await res.text();
        console.error("❌ GitHub error:", text);
        process.exit(1);
    }

    const repos: Array<{ name: string }> = await res.json();
    const excludedRepos = [
        ".github",
        "github-shared",
        "dev-guidelines",
        "fastlane-certs",
        "auth0-login-page-html",
        "technical-specs",
        "payment-fe-demo",
        "blog",
        "auth0-deploy-cli",
    ];
    return repos.filter((r) => !excludedRepos.includes(r.name));
}

async function getMergedPRs(repo: string): Promise<any[]> {
    const res = await fetch(
        `https://api.github.com/repos/${org}/${repo}/pulls?state=closed&base=production&per_page=30`,
        {
            headers: { Authorization: `Bearer ${githubToken}` },
        }
    );
    const prs = await res.json();
    console.log(`📌 Found ${prs.length} closed PRs in ${repo}`);
    return prs.filter(
        (pr: any) => pr.merged_at && mergedInLast24Hours(pr.merged_at)
    );
}

async function getCommits(
    repo: string,
    prNumber: number
): Promise<Array<{ message: string; author: string; sha: string }>> {
    const res = await fetch(
        `https://api.github.com/repos/${org}/${repo}/pulls/${prNumber}/commits`,
        {
            headers: { Authorization: `Bearer ${githubToken}` },
        }
    );
    const commits = await res.json();
    console.log(`📄 Found ${commits.length} commits in PR #${prNumber}`);
    return commits.map((c: any) => ({
        message: `- ${c.commit.message}`,
        author: c.author?.login || c.commit?.author?.name || "unknown",
        sha: c.sha, // ✅ This is what we need
    }));
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

async function summarizeProjectPRs(
    repo: string,
    summaries: Array<{ text: string }>
): Promise<string> {
    // Process summaries in chunks of 5 to stay within token limits
    const chunks = chunkArray(summaries, 5);
    const chunkSummaries: string[] = [];

    for (const chunk of chunks) {
        const promptLines = [
            `You are writing user-facing release notes for the '${repo}' project.`,
            "Focus on what users will experience and benefit from.",
            "Avoid technical jargon, internal references, or ticket numbers.",
            "Write in a friendly, engaging tone that highlights user value.",
            "Use bullet points for clarity.",
            "",
            "Here are the changes to summarize:",
            "",
            chunk.map((s) => s.text).join("\n"),
        ];

        const prompt = promptLines.join("\n");

        const res = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.4,
        });

        const summary =
            res.choices?.[0]?.message?.content?.trim() || "⚠️ No summary.";
        chunkSummaries.push(summary);
    }

    // If we have multiple chunks, combine them into a final summary
    if (chunkSummaries.length > 1) {
        const finalPromptLines = [
            `Combine these summaries of work in the '${repo}' project into one cohesive, user-facing summary.`,
            "Focus on the overall user experience and benefits.",
            "Maintain bullet point format for readability.",
            "Keep it concise and engaging.",
            "",
            "Summaries to combine:",
            "",
            chunkSummaries.join("\n\n"),
        ];

        const finalPrompt = finalPromptLines.join("\n");

        const finalRes = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: finalPrompt }],
            temperature: 0.4,
        });

        return (
            finalRes.choices?.[0]?.message?.content?.trim() || "⚠️ No summary."
        );
    }

    return chunkSummaries[0];
}

async function summarizePR(pr: any, commitsText: string): Promise<string> {
    // Split commits into chunks of roughly 5 commits each
    const commitLines = commitsText.split("\n");
    const chunks = chunkArray(commitLines, 5);

    // Truncate PR body if it's too long
    const maxBodyLength = 500;
    const truncatedBody = pr.body
        ? pr.body.length > maxBodyLength
            ? pr.body.substring(0, maxBodyLength) + "..."
            : pr.body
        : "";

    let combinedSummary = "";

    for (const chunk of chunks) {
        const chunkText = chunk.join("\n");
        const promptLines = [
            "You are writing user-facing release notes. Focus on what users will experience and benefit from.",
            "Avoid technical jargon, internal references, ticket numbers, or implementation details.",
            "Write in a friendly, engaging tone that highlights user value and improvements.",
            "Keep it brief and impactful.",
            "",
            "Pull Request Details:",
            `Title: ${pr.title}`,
            `Description: ${truncatedBody}`,
            "",
            "Recent commits:",
            chunkText,
        ];

        const prompt = promptLines.join("\n");

        const res = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.4,
            max_tokens: 500, // Limit response length
        });

        const chunkSummary =
            res.choices?.[0]?.message?.content?.trim() || "⚠️ No summary.";
        combinedSummary += chunkSummary + " ";
    }

    // If we have multiple chunks, get a final summary of the combined summaries
    if (chunks.length > 1) {
        const finalPromptLines = [
            "Combine these summaries into one concise, user-facing release note (max 2-3 sentences).",
            "Focus on the overall user experience and benefits.",
            "Avoid technical details and internal references.",
            "Make it engaging and valuable for end users.",
            "",
            "Summaries to combine:",
            "",
            combinedSummary,
        ];

        const finalPrompt = finalPromptLines.join("\n");

        const finalRes = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: finalPrompt }],
            temperature: 0.4,
            max_tokens: 200, // Limit final summary length
        });

        return (
            finalRes.choices?.[0]?.message?.content?.trim() ||
            combinedSummary.trim()
        );
    }

    return combinedSummary.trim();
}

async function getInspirationQuote(): Promise<string> {
    const promptLines = [
        "Provide an inspiring quote that would motivate a development team.",
        "Focus on themes like:",
        "- Building great products",
        "- Team collaboration",
        "- Innovation and progress",
        "- User impact",
        "",
        "Keep it concise and impactful (1-2 sentences max).",
        "Make it relevant for a daily release notes context.",
    ];

    const prompt = promptLines.join("\n");

    const res = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
    });
    return res.choices?.[0]?.message?.content?.trim() || "";
}

async function postToCanny({
    title,
    details,
}: {
    title: string;
    details: string;
}): Promise<string> {
    const postData = {
        apiKey: process.env.CANNY_API_KEY || "",
        title,
        details,
        published: "false",
    };

    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(postData)) {
        formBody.append(key, value);
    }

    const response = await fetch("https://canny.io/api/v1/entries/create", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody,
    });

    let result;
    try {
        const text = await response.text();
        result = JSON.parse(text);
    } catch (err) {
        console.error("❌ Failed to parse Canny response.");
        process.exit(1);
    }

    if (!response.ok || result?.error) {
        console.error("❌ Canny error:", result);
        process.exit(1);
    }

    console.log("✅ Posted to Canny:", result.id);
    return result.id;
}

async function postToSlack(cannyEntryId: string, title: string): Promise<void> {
    const slack = new WebClient(slackToken);
    const cannyUrl = `https://mallard-bay.canny.io/admin/changelog`;

    const message = `📝 *New Release Notes Draft*\n\n*${title}*\n\nA new draft entry has been created in Canny. You can review and publish it here:\n${cannyUrl}`;

    try {
        const result = await slack.chat.postMessage({
            channel: SLACK_CHANNEL,
            text: message,
            unfurl_links: false, // Prevent link preview to keep message clean
        });

        if (!result.ok) {
            console.error("❌ Slack error:", result.error);
            return;
        }

        console.log("✅ Posted to Slack successfully");
    } catch (error) {
        console.error("❌ Error posting to Slack:", error);
    }
}

async function findPRsByCommit(repo: string, sha: string): Promise<Array<any>> {
    const res = await fetch(
        `https://api.github.com/repos/${org}/${repo}/commits/${sha}/pulls`,
        {
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: "application/vnd.github.groot-preview+json",
            },
        }
    );

    if (!res.ok) {
        console.warn(`⚠️ Could not fetch PRs for commit ${sha} in ${repo}`);
        return [];
    }

    const prs = await res.json();
    return prs.filter((pr: any) => pr.base?.ref === "development");
}

async function processRepo(
    repoName: string,
    contributors: Set<string>,
    prLinks: string[]
): Promise<string | null> {
    console.log(`🛸 Processing repo ${repoName}`);

    const prs = await getMergedPRs(repoName);
    if (!prs.length) return null;

    const summaries: Array<{ text: string; images: string[] }> = [];

    for (const pr of prs) {
        const commits = await getCommits(repoName, pr.number);
        const summary = await summarizePR(pr, formatCommits(commits));
        const images = await collectImagesFromDevPRs(repoName, commits);

        summaries.push({ text: summary, images });
        prLinks.push(`- [${repoName} • ${pr.title}](${pr.html_url})`);
        commits.forEach((c) => contributors.add(c.author));

        console.log(
            `📝 Summary for PR #${pr.number}: ${summary.slice(0, 60)}...`
        );
    }

    if (!summaries.length) return null;

    const projectSummary = await summarizeProjectPRs(repoName, summaries);
    let section = `# 📦 ${repoName}\n\n${projectSummary}\n\n`;
    const uniqueImages = new Set<string>();
    summaries.forEach(({ images }) => {
        images.forEach((url) => uniqueImages.add(url));
    });
    uniqueImages.forEach((url) => {
        section += `![Image](${url})\n\n`;
    });
    return section;
}

async function collectImagesFromDevPRs(
    repo: string,
    commits: Array<{ message: string; sha: string }>
): Promise<string[]> {
    const allImages = new Set<string>();

    for (const commit of commits) {
        const sha = commit.sha;

        console.log(`🔍 Looking up dev PRs for commit SHA: ${sha}`);

        const devPRs = await findPRsByCommit(repo, sha);
        console.log(`🧵 Found ${devPRs.length} dev PR(s) for ${sha}`);

        for (const pr of devPRs) {
            console.log(`   ↪ PR #${pr.number} - ${pr.title}`);
            if (pr.number === 1631) {
                console.log(`   ✅ FOUND CANDIDATE PR #1631`);
            }

            const media = await extractMediaLinks(pr.body || "");

            if (media.length) {
                console.log(
                    `   📸 Extracted ${media.length} media URLs from PR #${pr.number}`
                );
            } else {
                console.log(`   ⚠️ No media found in PR #${pr.number}`);
            }

            media.forEach(({ url }) => allImages.add(url));
        }
    }

    console.log(`✅ Collected ${allImages.size} total media items\n`);
    return Array.from(allImages);
}

async function extractMediaLinks(body: string): Promise<MediaAsset[]> {
    const allGithubUploadUrls = Array.from(
        new Set(
            body.match(
                /https:\/\/(?:user-images\.githubusercontent\.com|github\.com\/user-attachments\/assets)\/[^\s)]+/g
            ) || []
        )
    );

    const results: MediaAsset[] = [];

    for (const originalUrl of allGithubUploadUrls) {
        if (rehostCache.has(originalUrl)) {
            results.push({
                url: rehostCache.get(originalUrl)!,
                type: isVideo(originalUrl) ? "video" : "image",
            });
            continue;
        }

        console.log(`🔄 Rehosting GitHub upload: ${originalUrl}`);
        const rehosted = await rehydrateGitHubAssetToUploadcare(originalUrl);

        if (!rehosted) {
            console.warn(`⚠️ Failed to rehost: ${originalUrl}`);
            continue;
        }

        rehostCache.set(originalUrl, rehosted);
        results.push({
            url: rehosted,
            type: isVideo(rehosted) ? "video" : "image",
        });
    }

    return results;
}

function isVideo(url: string): boolean {
    return /\.(mp4|mov|webm)$/i.test(url);
}

function formatCommits(commits: Array<{ message: string }>): string {
    return commits.map((c) => c.message).join("\n");
}

function formatContributors(contributors: Set<string>): string {
    const names = Array.from(contributors).filter(
        (n) => n !== "semantic-release-bot"
    );
    return names.length
        ? `# 🙌 Kudos to\n${names.map((n) => `@${n}`).join(", ")}\n\n`
        : "";
}

async function formatQuote(): Promise<string> {
    const quote = await getInspirationQuote();
    return quote ? `> 💡 ${quote}\n\n` : "";
}

function formatPRLinks(links: string[]): string {
    return links.length ? `# 🔗 Pull Requests\n${links.join("\n")}\n\n` : "";
}

async function rehydrateGitHubAssetToUploadcare(
    githubUrl: string
): Promise<string | null> {
    try {
        const githubRes = await fetch(githubUrl, {
            headers: {
                Authorization: `Bearer ${process.env.GITHUB_TOKEN || ""}`,
            },
        });

        if (!githubRes.ok) {
            console.warn(`❌ GitHub asset fetch failed: ${githubUrl}`);
            return null;
        }

        const blob = await githubRes.buffer();
        const contentType = githubRes.headers.get("content-type") || "";
        const isVideoAsset = /video|mp4|quicktime|webm/i.test(contentType);
        const ext = getExtensionFromMime(contentType);
        const filename = getFilenameFromGitHubUrl(githubUrl, ext);

        const form = new FormData();
        form.append(
            "UPLOADCARE_PUB_KEY",
            process.env.UPLOADCARE_PUBLIC_KEY || ""
        );
        form.append("UPLOADCARE_STORE", "auto");
        form.append("file", blob, { filename });

        const uploadRes = await fetch("https://upload.uploadcare.com/base/", {
            method: "POST",
            body: form,
        });

        if (!uploadRes.ok) {
            console.warn(`❌ Uploadcare upload failed`);
            return null;
        }

        const { file: fileId, ...rest } = await uploadRes.json();
        console.log(`RESP`, rest);

        const baseUrl = `https://ucarecdn.com/${fileId}/`;
        // return isVideoAsset ? `${baseUrl}-/video/` : baseUrl;
        return baseUrl;
    } catch (err) {
        console.error(`💥 Error rehosting asset: ${githubUrl}`, err);
        return null;
    }
}

function getFilenameFromGitHubUrl(url: string, ext: string): string {
    const match = url.match(/assets\/([a-z0-9-]+)/i);
    const id = match?.[1] || "upload";
    return `${id}.${ext}`;
}

function getExtensionFromMime(mime: string): string {
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("quicktime")) return "mov";
    if (mime.includes("webm")) return "webm";
    if (mime.includes("png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("gif")) return "gif";
    return "bin";
}

type MediaAsset = {
    url: string;
    type: "image" | "video";
};
