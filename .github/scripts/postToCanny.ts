import fetch from "node-fetch";
import OpenAI from "openai";

const githubToken: string | undefined = process.env.GITHUB_TOKEN;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const org: string | undefined = process.env.GITHUB_ORG;

const today = new Date();

if (!githubToken) {
    console.error("❌ Missing GITHUB_TOKEN environment variable.");
    process.exit(1);
}

if (!org) {
    console.error("❌ Missing GITHUB_ORG environment variable.");
    process.exit(1);
}

main();

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
): Promise<Array<{ message: string; author: string }>> {
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

async function main(): Promise<void> {
    console.log("🚀 Generating grouped changelog...");
    const repos = await getRepos();

    const title = `Release Notes - Past 24 Hours`;
    let details = "";
    const allContributors = new Set<string>();
    const allPRLinks: string[] = [];

    for (const repo of repos) {
        const prs = await getMergedPRs(repo.name);
        if (!prs.length) continue;

        const summaries: Array<{ text: string; images: string[] }> = [];

        for (const pr of prs) {
            const commits = await getCommits(repo.name, pr.number);
            const commitsText = commits.map((c) => c.message).join("\n");
            const summary = await summarizePR(pr, commitsText);
            const images =
                (pr.body || "").match(
                    /https:\/\/user-images\.githubusercontent\.com\/[^\s)]+/g
                ) || [];

            console.log(
                `📝 Summary for PR #${pr.number}: ${summary.slice(0, 60)}...`
            );
            summaries.push({ text: summary, images });
            allPRLinks.push(`- [${repo.name} • ${pr.title}](${pr.html_url})`);

            commits.forEach((c) => allContributors.add(c.author));
        }

        const projectSummary = await summarizeProjectPRs(repo.name, summaries);
        details += `# 📦 ${repo.name}\n\n${projectSummary}\n\n`;

        summaries.forEach(({ images }) => {
            images.forEach((url) => {
                details += `![Image](${url})\n\n`;
            });
        });
    }

    if (!details.trim()) {
        console.log("📭 No PRs merged yesterday.");
        return;
    }

    if (allContributors.size) {
        const kudosTo = Array.from(allContributors).filter(
            (name) => name !== "semantic-release-bot"
        );
        details += `# 🙌 Kudos to\n${kudosTo
            .map((n) => `@${n}`)
            .join(", ")}\n\n`;
    }

    const quote = await getInspirationQuote();
    if (quote) {
        details += `> 💡 ${quote}\n\n`;
    }

    if (allPRLinks.length) {
        details += `# 🔗 Pull Requests\n${allPRLinks.join("\n")}\n\n`;
    }

    await postToCanny({ title, details });
}
