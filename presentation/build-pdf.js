// Builds TrackBot-presentation.pdf from slides.html (one 16:9 page per slide).
//   node presentation/build-pdf.js
// Needs Playwright; set PW_CHANNEL=chrome to use an installed Chrome.
const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage();
  await page.goto("file://" + path.resolve(__dirname, "slides.html"));
  await page.waitForLoadState("load");
  await page.pdf({
    path: path.resolve(__dirname, "TrackBot-presentation.pdf"),
    width: "1280px", height: "720px", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  await browser.close();
  console.log("wrote presentation/TrackBot-presentation.pdf");
})();
