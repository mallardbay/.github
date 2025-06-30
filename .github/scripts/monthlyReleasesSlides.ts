import { google } from "googleapis";
import type { slides_v1 } from "googleapis";
import fetch from "node-fetch";
import * as path from "path";
import OpenAI from "openai";
import { WebClient } from "@slack/web-api";

import { isBeginningOfCycle } from "./helpers";

const TEMPLATE_ID = "10XaYbPMpHJuo3MdE2HEnjFE-Neh6MZo_8IjagT7Nucg";
const EDITORS = ["manny@mallardbay.com", "coco@mallardbay.com"];
const MAX_BULLETS_PER_PAGE = 6;
const MAX_IMAGES_PER_PAGE = 9;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const SLACK_CHANNEL = "#dev-github-actions";

const credentialsPath = ".github/scripts/googleCredentials.json";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

interface ChangelogEntry {
    _id: string;
    title: string;
    markdownDetails?: string;
    created: string;
}

/**
 * Validates if a URL is a valid HTTP/HTTPS URL
 * @param url - The URL to validate
 * @returns true if the URL is valid, false otherwise
 */
function isValidImageUrl(url: string): boolean {
    return Boolean(
        url && (url.startsWith("http://") || url.startsWith("https://"))
    );
}

/**
 * Validates if an image URL is accessible and returns appropriate format/size info
 * @param url - The URL to validate
 * @returns Promise<boolean> - true if the image is accessible
 */
async function isImageAccessible(url: string): Promise<boolean> {
    try {
        console.log(`🔍 Checking image accessibility: ${url}`);
        const response = await fetch(url, { method: "HEAD" });

        if (!response.ok) {
            console.log(`❌ Image not accessible (${response.status}): ${url}`);
            return false;
        }

        const contentType = response.headers.get("content-type");
        const contentLength = response.headers.get("content-length");

        console.log(
            `✅ Image accessible: ${url} (${contentType}, ${contentLength} bytes)`
        );

        // Check if it's a supported image format
        const supportedFormats = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/gif",
            // "image/webp",
            "image/svg+xml",
        ];
        if (
            !contentType ||
            !supportedFormats.some((format) => contentType.includes(format))
        ) {
            console.log(`⚠️ Unsupported image format (${contentType}): ${url}`);
            return false;
        }

        // Check if file size is reasonable (less than 10MB)
        if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE_BYTES) {
            console.log(`⚠️ Image too large (${contentLength} bytes): ${url}`);
            return false;
        }

        return true;
    } catch (error) {
        console.log(`❌ Error checking image (${error.message}): ${url}`);
        return false;
    }
}

main().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});

async function main(): Promise<void> {
    validateEnvVars();

    console.log("🚀 Starting changelog slide generation...");

    if (!shouldRun()) {
        console.log("Skipping run...");
        return;
    }

    const entries = await fetchRecentChangelogEntries();
    if (!entries.length) {
        console.log("⚠️ No recent changelog entries found.");
        return;
    }

    console.log("🧠 Summarizing entries and grouping...");
    const grouped = await groupAndSummarizeEntries(entries);

    console.log("🖼️ Extracting images by group...");
    const images = await collectImagesByGroup(entries, grouped);

    console.log("💬 Fetching inspirational quote...");
    const quote = await getInspirationQuote();

    console.log("📊 Creating slides...");
    const presentationId = await createSlides(grouped, images, quote);
    console.log("✅ Slide generation complete, posting to slack...");

    await postToSlack(
        `✅ Monthly Product Slides created: https://docs.google.com/presentation/d/${presentationId} \n \n`
    );

    console.log("Done with slack!");
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
    const BATCH_SIZE = 10;
    const results = {
        features: [] as string[],
        improvements: [] as string[],
        fixes: [] as string[],
    };

    // Process entries in batches
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const formatted = batch
            .map(
                (e, idx) =>
                    `${idx + 1}. Title: ${e.title}\nDescription: ${
                        e.markdownDetails
                    }`
            )
            .join("\n\n");

        const prompt = `You are summarizing a product changelog. Categorize each entry as a Feature, Improvement, or Fix. For each group, write concise bullet points. Respond in JSON:\n{\n  \"features\": [\"...\"],\n  \"improvements\": [\"...\"],\n  \"fixes\": [\"...\"]\n}\n\nEntries:\n${formatted}`;

        const res = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
        });

        const json = res.choices[0].message.content!.trim();
        const batchResults = JSON.parse(json);

        // Merge results
        results.features.push(...batchResults.features);
        results.improvements.push(...batchResults.improvements);
        results.fixes.push(...batchResults.fixes);
    }

    console.log("🧩 Grouping results parsed from OpenAI response.");
    return results;
}

export function extractImages(markdown: string): string[] {
    const matches = markdown.match(/!\[.*?\]\((.*?)\)/g) || [];
    return matches
        .map((match) => {
            const urlMatch = match.match(/\((.*?)\)/);
            return urlMatch ? urlMatch[1] : "";
        })
        .filter(Boolean)
        .filter(isValidImageUrl);
}

async function collectImagesByGroup(entries: ChangelogEntry[], groups: any) {
    console.log("🧹 Sorting images by group...");
    const imageMap: Record<string, string[]> = {
        features: [],
        improvements: [],
        fixes: [],
    };

    for (const entry of entries) {
        const images = extractImages(entry.markdownDetails || "");
        if (images.length > 0) {
            console.log(
                `📸 Found ${images.length} valid images in entry: ${entry.title}`
            );
        }
        const text = `${entry.title} ${
            entry.markdownDetails || ""
        }`.toLowerCase();

        for (const type of ["features", "improvements", "fixes"]) {
            if (
                groups[type].some((s: string) =>
                    text.includes(s.split(" ")[0].toLowerCase())
                )
            ) {
                // Validate image accessibility before adding to the group
                for (const imageUrl of images) {
                    if (await isImageAccessible(imageUrl)) {
                        imageMap[type].push(imageUrl);
                    } else {
                        console.log(
                            `🚫 Skipping inaccessible image: ${imageUrl}`
                        );
                    }
                }
                break;
            }
        }
    }

    // Log summary of images found
    const totalImages =
        imageMap.features.length +
        imageMap.improvements.length +
        imageMap.fixes.length;
    console.log(
        `📊 Total accessible images found: ${totalImages} (features: ${imageMap.features.length}, improvements: ${imageMap.improvements.length}, fixes: ${imageMap.fixes.length})`
    );

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
    const slidesApi = google.slides({ version: "v1", auth });
    const presentationId = await copyTemplatePresentation(auth, TEMPLATE_ID);
    const presentationResp = await slidesApi.presentations.get({
        presentationId,
    });
    const presentation = presentationResp.data;

    const titleMap = {
        features: "New Features 🚀",
        improvements: "Improvements ✨",
        fixes: "Bug Fixes 🛠️",
    };

    let groupSlideRequests: any[] = [];
    let otherSlideRequests: any[] = [];
    let followupRequests: any[] = [];

    const insertionIndex = getInsertionIndex(presentation);

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
                    insertionIndex: insertionIndex ?? undefined,
                    slideLayoutReference: {
                        predefinedLayout: "TITLE_AND_BODY",
                    },
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
        console.log(
            `📊 Creating image slide ${slideId} with ${chunk.length} images...`
        );
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
                slideLayoutReference: {
                    predefinedLayout: "TITLE_AND_BODY",
                },
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

    // Insert group slides before "That's All Folks!"
    await slidesApi.presentations.batchUpdate({
        presentationId,
        requestBody: {
            requests: groupSlideRequests,
        },
    });

    // Then insert all other slides normally
    await slidesApi.presentations.batchUpdate({
        presentationId,
        requestBody: {
            requests: [...otherSlideRequests, ...followupRequests],
        },
    });

    return presentationId;
}

function getInsertionIndex(presentation: slides_v1.Schema$Presentation) {
    // Insert before the last slide
    const slides = presentation.slides;
    if (!slides) throw new Error("No slides passed");

    // Insertion index
    const insertionIndex = slides?.length - 1;

    return insertionIndex;
}

function createImageSlide(slideId: string, imageUrls: string[]): any[] {
    // Filter out invalid URLs as a safety measure
    const validImageUrls = imageUrls.filter(isValidImageUrl);

    if (validImageUrls.length !== imageUrls.length) {
        console.log(
            `⚠️ Filtered out ${
                imageUrls.length - validImageUrls.length
            } invalid image URLs`
        );
        console.log(
            `🔗 Invalid URLs:`,
            imageUrls.filter((url) => !isValidImageUrl(url))
        );
    }

    console.log(
        `🖼️ Creating image slide with ${validImageUrls.length} images:`
    );
    validImageUrls.forEach((url, index) => {
        console.log(`  ${index + 1}. ${url}`);
    });

    const imageElements = validImageUrls.map((url, index) => {
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

    // Set permissions for each editor
    for (const editor of EDITORS) {
        await drive.permissions.create({
            fileId,
            requestBody: {
                type: "user",
                role: "writer",
                emailAddress: editor,
            },
            fields: "id",
        });
    }

    // Also, anyone with the link should be able to read
    await drive.permissions.create({
        fileId,
        requestBody: {
            type: "anyone",
            role: "reader",
        },
    });

    return fileId;
}

async function postToSlack(message) {
    const slack = new WebClient(process.env.SLACK_TOKEN);

    await slack.chat.postMessage({
        channel: SLACK_CHANNEL,
        text: message,
    });
}

function shouldRun() {
    const now = new Date();

    return isBeginningOfCycle(now);
}

function validateEnvVars() {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("Missing required env variable: OPENAI_API_KEY");
    }

    if (!process.env.CANNY_API_KEY) {
        throw new Error("Missing required env variable: CANNY_API_KEY");
    }

    if (!process.env.SLACK_TOKEN) {
        throw new Error("Missing required env variable: SLACK_TOKEN");
    }
}
