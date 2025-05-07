import fetch from "node-fetch";
import OpenAI from "openai";
import FormData from "form-data";

const githubToken: string | undefined = process.env.GITHUB_TOKEN;
const uploadcarePublicKey = process.env.UPLOADCARE_PUBLIC_KEY;
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

    await postToCanny({ title: `Release Notes - Past 24 Hours`, details });
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

async function summarizeProjectPRs(
    repo: string,
    summaries: Array<{ text: string }>
): Promise<string> {
    const prompt = `Write a short, friendly, summary of today's merged work in the '${repo}' project, use bullets:\n\n${summaries
        .map((s) => s.text)
        .join("\n")}`;
    const res = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
    });
    return res.choices?.[0]?.message?.content?.trim() || "⚠️ No summary.";
}

async function summarizePR(pr: any, commitsText: string): Promise<string> {
    const prompt = `Summarize this pull request (keep it brief) in user-facing release notes style:\n\nTitle: ${pr.title}\n\nBody: ${pr.body}\n\nCommits:\n${commitsText}`;
    const res = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
    });
    return res.choices?.[0]?.message?.content?.trim() || "⚠️ No summary.";
}

async function getInspirationQuote(): Promise<string> {
    const prompt =
        "Give me an inspiring quote about building products, startups, leadership.";
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
}): Promise<void> {
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

        console.log(`>>>>>>>>`, contentType, isVideoAsset);

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

// async function main(): Promise<void> {
//     console.log("🚀 Generating grouped changelog...");
//     const repos = await getRepos();

//     const title = `Release Notes - Past 24 Hours`;
//     let details = "";
//     const allContributors = new Set<string>();
//     const allPRLinks: string[] = [];

//     for (const repo of repos) {
//         const prs = await getMergedPRs(repo.name);
//         if (!prs.length) continue;

//         const summaries: Array<{ text: string; images: string[] }> = [];

//         for (const pr of prs) {
//             const commits = await getCommits(repo.name, pr.number);
//             const commitsText = commits.map((c) => c.message).join("\n");
//             const summary = await summarizePR(pr, commitsText);
//             const images =
//                 (pr.body || "").match(
//                     /https:\/\/user-images\.githubusercontent\.com\/[^\s)]+/g
//                 ) || [];

//             console.log(
//                 `📝 Summary for PR #${pr.number}: ${summary.slice(0, 60)}...`
//             );
//             summaries.push({ text: summary, images });
//             allPRLinks.push(`- [${repo.name} • ${pr.title}](${pr.html_url})`);

//             commits.forEach((c) => allContributors.add(c.author));
//         }

//         const projectSummary = await summarizeProjectPRs(repo.name, summaries);
//         details += `# 📦 ${repo.name}\n\n${projectSummary}\n\n`;

//         summaries.forEach(({ images }) => {
//             images.forEach((url) => {
//                 details += `![Image](${url})\n\n`;
//             });
//         });
//     }

//     if (!details.trim()) {
//         console.log("📭 No PRs merged yesterday.");
//         return;
//     }

//     if (allContributors.size) {
//         const kudosTo = Array.from(allContributors).filter(
//             (name) => name !== "semantic-release-bot"
//         );
//         details += `# 🙌 Kudos to\n${kudosTo
//             .map((n) => `@${n}`)
//             .join(", ")}\n\n`;
//     }

//     const quote = await getInspirationQuote();
//     if (quote) {
//         details += `> 💡 ${quote}\n\n`;
//     }

//     if (allPRLinks.length) {
//         details += `# 🔗 Pull Requests\n${allPRLinks.join("\n")}\n\n`;
//     }

//     await postToCanny({ title, details });
// }
