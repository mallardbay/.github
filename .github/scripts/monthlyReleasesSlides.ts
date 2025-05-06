import { google } from "googleapis";
import fetch from "node-fetch";
import * as path from "path";
import OpenAI from "openai";

const TEMPLATE_ID = "1XVHQithNmY-JL-vL7hSS-UjTADN6C9C_bg1k8tU7amE";
const PRESENTATION_AUTHOR = "manny@mallardbay.com";
const MAX_BULLETS_PER_PAGE = 7;
const MAX_IMAGES_PER_PAGE = 9;

const credentialsPath = ".github/scripts/googleCredentials.json";

if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing required env variable: OPENAI_API_KEY");
}

if (!process.env.CANNY_API_KEY) {
    throw new Error("Missing required env variable: CANNY_API_KEY");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

interface ChangelogEntry {
    _id: string;
    title: string;
    markdownDetails?: string;
    created: string;
}

main().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});

async function main(): Promise<void> {
    console.log("🚀 Starting changelog slide generation...");

    const entries = await fetchRecentChangelogEntries();
    if (!entries.length) {
        console.log("⚠️ No recent changelog entries found.");
        return;
    }

    console.log("🧠 Summarizing entries and grouping...");
    const grouped = await groupAndSummarizeEntries(entries);

    console.log("🖼️ Extracting images by group...");
    const images = collectImagesByGroup(entries, grouped);

    console.log("💬 Fetching inspirational quote...");
    const quote = await getInspirationQuote();

    console.log("📊 Creating slides...");
    await createSlides(grouped, images, quote);

    console.log("Slide generation complete.");
}

async function fetchRecentChangelogEntries(): Promise<ChangelogEntry[]> {
    console.log("📡 Fetching changelog entries from Canny...");
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const entries: ChangelogEntry[] = [];
    const limit = 100;
    let skip = 0;
    let keepGoing = true;

    while (keepGoing) {
        console.log(`🔄 Fetching page with skip=${skip}`);
        const body = new URLSearchParams({
            apiKey: process.env.CANNY_API_KEY!,
            limit: limit.toString(),
            skip: skip.toString(),
        });

        const res = await fetch("https://canny.io/api/v1/entries/list", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });

        if (!res.ok) {
            throw new Error(
                `Canny fetch failed: ${res.status} ${await res.text()}`
            );
        }

        const data = await res.json();
        const page: ChangelogEntry[] = data.entries;
        if (!page.length) break;

        for (const entry of page) {
            if (new Date(entry.created) < fourWeeksAgo) {
                keepGoing = false;
                break;
            }
            entries.push(entry);
        }

        skip += limit;
    }

    console.log(`📦 Retrieved ${entries.length} changelog entries.`);
    return entries;
}

async function authorizeWithGoogle(credentialsPath: string) {
    console.log("🔐 Authorizing with Google...");
    const auth = new google.auth.GoogleAuth({
        keyFile: path.resolve(credentialsPath),
        scopes: [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/presentations",
        ],
    });
    return await auth.getClient();
}

async function groupAndSummarizeEntries(entries: ChangelogEntry[]) {
    const formatted = entries
        .map(
            (e, i) =>
                `${i + 1}. Title: ${e.title}\nDescription: ${e.markdownDetails}`
        )
        .join("\n\n");
    const prompt = `You are summarizing a product changelog. Categorize each entry as a Feature, Improvement, or Fix. For each group, write concise bullet points. Respond in JSON:\n{\n  \"features\": [\"...\"],\n  \"improvements\": [\"...\"],\n  \"fixes\": [\"...\"]\n}\n\nEntries:\n${formatted}`;

    const res = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
    });

    const json = res.choices[0].message.content!.trim();
    console.log("🧩 Grouping result parsed from OpenAI response.");
    return JSON.parse(json);
}

export function extractImages(markdown: string): string[] {
    const matches = markdown.match(/!\[.*?\]\((.*?)\)/g) || [];
    return matches
        .map((match) => {
            const urlMatch = match.match(/\((.*?)\)/);
            return urlMatch ? urlMatch[1] : "";
        })
        .filter(Boolean);
}

function collectImagesByGroup(entries: ChangelogEntry[], groups: any) {
    console.log("🧹 Sorting images by group...");
    const imageMap: Record<string, string[]> = {
        features: [],
        improvements: [],
        fixes: [],
    };

    for (const entry of entries) {
        const images = extractImages(entry.markdownDetails || "");
        const text = `${entry.title} ${
            entry.markdownDetails || ""
        }`.toLowerCase();

        for (const type of ["features", "improvements", "fixes"]) {
            if (
                groups[type].some((s: string) =>
                    text.includes(s.split(" ")[0].toLowerCase())
                )
            ) {
                imageMap[type].push(...images);
                break;
            }
        }
    }

    return imageMap;
}

async function getInspirationQuote(): Promise<string> {
    const res = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            {
                role: "user",
                content:
                    "Give me an inspiring quote about building products, or startups.",
            },
        ],
        temperature: 0.7,
    });
    const quote = res.choices?.[0]?.message?.content?.trim() || "";
    console.log(`💡 Quote fetched: ${quote}`);
    return quote;
}

async function createSlides(grouped: any, images: any, quote: string) {
    const auth = (await authorizeWithGoogle(credentialsPath)) as any;
    const slides = google.slides({ version: "v1", auth });
    const presentationId = await copyTemplatePresentation(auth, TEMPLATE_ID);
    const layoutId = "g294fac71dd6_0_36";

    const titleMap = {
        features: "New Features 🚀",
        improvements: "Improvements ✨",
        fixes: "Bug Fixes 🛠️",
    };

    let groupSlideRequests: any[] = [];
    let otherSlideRequests: any[] = [];
    let followupRequests: any[] = [];

    // Locate "That’s All Folks!" slide
    const insertionIndex = await findSlideIndexByText(
        slides,
        presentationId,
        "That's All Folks!"
    );

    console.log(
        `📍 Inserting group slides at index: ${insertionIndex ?? "end"}`
    );

    for (const [groupKey, titleText] of Object.entries(titleMap)) {
        const groupItems: string[] = grouped[groupKey] || [];

        for (let i = 0; i < groupItems.length; i += MAX_BULLETS_PER_PAGE) {
            const bulletPoints = groupItems
                .slice(i, i + MAX_BULLETS_PER_PAGE)
                .map((s: string) => `• ${s}`)
                .join("\n");

            const slideId = `slide_${groupKey}_${i / MAX_BULLETS_PER_PAGE}`;
            const titleBoxId = `title_${groupKey}_${i / MAX_BULLETS_PER_PAGE}`;
            const bodyBoxId = `body_${groupKey}_${i / MAX_BULLETS_PER_PAGE}`;

            groupSlideRequests.push({
                createSlide: {
                    objectId: slideId,
                    insertionIndex: insertionIndex ?? undefined, // ✅ HERE
                    slideLayoutReference: { layoutId },
                    placeholderIdMappings: [
                        {
                            layoutPlaceholder: { type: "TITLE" },
                            objectId: titleBoxId,
                        },
                        {
                            layoutPlaceholder: { type: "BODY" },
                            objectId: bodyBoxId,
                        },
                    ],
                },
            });

            followupRequests.push(
                { insertText: { objectId: titleBoxId, text: titleText } },
                {
                    insertText: {
                        objectId: bodyBoxId,
                        text: bulletPoints || "—",
                    },
                }
            );
        }
    }

    // Add image slides
    const allImages = [
        ...images.features,
        ...images.improvements,
        ...images.fixes,
    ];
    let imageIndex = 0;
    for (let i = 0; i < allImages.length; i += MAX_IMAGES_PER_PAGE) {
        const slideId = `images_all_${imageIndex++}`;
        const chunk = allImages.slice(i, i + MAX_IMAGES_PER_PAGE);
        followupRequests.push(...createImageSlide(slideId, chunk));
    }

    // Quote slide
    if (quote) {
        const slideId = "slide_quote";
        const titleBoxId = "title_quote";
        const bodyBoxId = "body_quote";

        otherSlideRequests.push({
            createSlide: {
                objectId: slideId,
                slideLayoutReference: { layoutId },
                placeholderIdMappings: [
                    {
                        layoutPlaceholder: { type: "TITLE" },
                        objectId: titleBoxId,
                    },
                    {
                        layoutPlaceholder: { type: "BODY" },
                        objectId: bodyBoxId,
                    },
                ],
            },
        });

        followupRequests.push(
            {
                insertText: {
                    objectId: titleBoxId,
                    text: "Quote of the Day 💡",
                },
            },
            { insertText: { objectId: bodyBoxId, text: quote } }
        );
    }

    // Insert group slides before "That’s All Folks!"
    await slides.presentations.batchUpdate({
        presentationId,
        requestBody: {
            requests: groupSlideRequests,
        },
    });

    // Then insert all other slides normally
    await slides.presentations.batchUpdate({
        presentationId,
        requestBody: {
            requests: [...otherSlideRequests, ...followupRequests],
        },
    });

    console.log(
        `✅ Slides created: https://docs.google.com/presentation/d/${presentationId}`
    );
}

async function findSlideIndexByText(
    slidesApi: any,
    presentationId: string,
    targetText: string
): Promise<number | null> {
    // Fetch the full presentation
    const presentation = await slidesApi.presentations.get({ presentationId });
    const slides = presentation.data.slides || [];

    // Normalize the target text for consistent matching
    const normalizedTarget = targetText.toLowerCase().replace(/[’']/g, "'");

    // Loop through all slides
    for (let i = 0; i < slides.length; i++) {
        const elements = slides[i].pageElements || [];

        // Loop through each element on the slide
        for (const el of elements) {
            // Get all text elements from the shape (if it exists)
            const textRuns = el.shape?.text?.textElements || [];

            // Combine all the text chunks in this shape into a single string
            const combinedText = textRuns
                .map((t) => t.textRun?.content || "")
                .join("")
                .toLowerCase()
                .replace(/[’']/g, "'");

            // Check if the combined text contains the normalized target
            if (combinedText.includes(normalizedTarget)) {
                return i; // Return the index of the matching slide
            }
        }
    }

    // Return null if no matching slide is found
    return null;
}

function createImageSlide(slideId: string, imageUrls: string[]): any[] {
    const imageElements = imageUrls.map((url, index) => {
        const col = index % 3;
        const row = Math.floor(index / 3);

        return {
            createImage: {
                url,
                elementProperties: {
                    pageObjectId: slideId,
                    size: {
                        height: { magnitude: 100, unit: "PT" },
                        width: { magnitude: 150, unit: "PT" },
                    },
                    transform: {
                        scaleX: 1,
                        scaleY: 1,
                        translateX: 50 + col * 170,
                        translateY: 100 + row * 120, // leave room for title
                        unit: "PT",
                    },
                },
            },
        };
    });

    const titleId = `${slideId}_title`;

    const titleElement = {
        createShape: {
            objectId: titleId,
            shapeType: "TEXT_BOX",
            elementProperties: {
                pageObjectId: slideId,
                size: {
                    height: { magnitude: 40, unit: "PT" },
                    width: { magnitude: 600, unit: "PT" },
                },
                transform: {
                    scaleX: 1,
                    scaleY: 1,
                    translateX: 50,
                    translateY: 30,
                    unit: "PT",
                },
            },
        },
    };

    const insertTitleText = {
        insertText: {
            objectId: titleId,
            text: "Images",
        },
    };

    return [
        {
            createSlide: {
                objectId: slideId,
                slideLayoutReference: {
                    predefinedLayout: "BLANK",
                },
            },
        },
        titleElement,
        insertTitleText,
        ...imageElements,
    ];
}

async function copyTemplatePresentation(
    auth: any,
    templateId: string
): Promise<string> {
    const drive = google.drive({ version: "v3", auth });
    const res = await drive.files.copy({
        fileId: templateId,
        requestBody: {
            name: `Canny Changelog – ${new Date().toLocaleDateString()}`,
        },
    });

    const fileId = res.data.id!;
    console.log(
        `📄 Slide copied: https://docs.google.com/presentation/d/${fileId}`
    );

    // await drive.permissions.create({
    //     fileId,
    //     requestBody: {
    //         type: "user",
    //         role: "writer",
    //         emailAddress: PRESENTATION_AUTHOR,
    //     },
    //     fields: "id",
    // });

    await drive.permissions.create({
        fileId,
        requestBody: {
            type: "anyone",
            role: "reader", // or "writer" if you want link-based editing
        },
    });

    return fileId;
}
