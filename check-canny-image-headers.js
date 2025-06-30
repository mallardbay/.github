import fetch from "node-fetch";

const urls = [
    "https://canny-assets.io/images/d0ec7ae2d6e4117afb7bda47c5f06953.png",
    "https://canny-assets.io/images/e56a77b5f5eb1d6388edffaab4d595ce.png",
    "https://canny-assets.io/images/b1e80c340ee7fa56e3eb5ed33d0c7f58.png",
    "https://canny-assets.io/images/e9a5df291dff2bec83a9a540e41a0f5e.png",
    "https://canny-assets.io/images/71b08952e9f9ea9ab3b80b89ccfb0a97.png",
    "https://canny-assets.io/images/d248fa8fa18b2dde2ea77f82461883b3.png",
    "https://canny-assets.io/images/8f4372c707340dd0b04c82c608bbe44f.png",
    "https://canny-assets.io/images/568ef61e9f8f54cf9fabc7ae3abb6240.webp",
    "https://canny-assets.io/images/e17deb06c54cbec386800c1d7dfbfc73.webp",
    "https://canny-assets.io/images/885bb43d8554c344f6dee54b5268cf0c.webp",
    "https://canny-assets.io/images/31c21062f79eb98e4fd002eb5e37cf13.png",
    "https://canny-assets.io/images/d76a741cd492325987d15fae50d0fd71.png",
    "https://canny-assets.io/images/646e90dd153adc2961fb91957c91ee5b.png",
    "https://canny-assets.io/images/2c545f184126aad2ff3476e139a8fc50.png",
    "https://canny-assets.io/images/a2d148c39d35b5d362520a1e5fcdf32e.png",
    "https://canny-assets.io/images/2e2e7e5db73acbde7639e238f6224c27.png",
];

async function checkHeaders() {
    for (const url of urls) {
        try {
            const res = await fetch(url, { method: "HEAD" });
            const status = res.status;
            const contentType = res.headers.get("content-type");
            const contentLength = res.headers.get("content-length");
            console.log(`${url}`);
            console.log(`  Status: ${status}`);
            console.log(`  Content-Type: ${contentType}`);
            console.log(`  Content-Length: ${contentLength}`);
            console.log("---");
        } catch (err) {
            console.log(`${url}`);
            console.log(`  ERROR: ${err.message}`);
            console.log("---");
        }
    }
}

checkHeaders();
