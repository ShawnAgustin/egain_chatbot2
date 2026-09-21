// Captures the README screenshots from a RUNNING server, in agent mode.
//   npm start                                   (needs GEMINI_API_KEY in .env)
//   node shoot.js                               (uses http://localhost:3000)
//   TRACKBOT_URL=http://localhost:3001 node shoot.js
//   node shoot.js 04                            (only the shots whose name contains "04")
// Set PW_CHANNEL=chrome to use an installed Chrome instead of Playwright's own browser.
const { chromium } = require("playwright");

const URL = process.env.TRACKBOT_URL || "http://localhost:3000";

const shots = [
  { name: "01-delivered-but-missing", steps: ["EG-58120", "nah it's definitely not out there, asked next door too", "I'd like a refund"] },
  { name: "02-error-handling",        steps: ["where is my stuff", "EG-99999"] },
  { name: "03-in-transit-not-lost",   steps: ["EG-77441", "yes please let me know when it gets here"] },
  { name: "04-upset-handoff",         steps: ["EG-10293", "this is so annoying, it's been weeks", "SERIOUSLY?? this is ridiculous"],
    panel: "presentation/panel-upset.png" },     // the chat panel alone, cropped by the slides
  { name: "05-view-all-orders",       steps: [], after: async page => {
      await page.click("#ordersToggle");
      await page.waitForSelector(".orow");
      await page.addStyleTag({ content: "#orderList{max-height:none!important}" });
  } },
];

(async () => {
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  for (const shot of shots.filter(s => !process.argv[2] || s.name.includes(process.argv[2]))) {
    const page = await browser.newPage({ viewportSize: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    // The page's config.js may point at the hosted server; use the one we're running.
    await page.route("**/config.js", r => r.fulfill({ contentType: "text/javascript", body: 'window.TRACKBOT_API = "";' }));
    await page.goto(URL);
    await page.waitForFunction(() => /Gemini/.test(document.getElementById("mode").textContent), null, { timeout: 15000 });
    for (const s of shot.steps) {
      await page.fill("#entry", s);
      await page.click("button[type=submit]");
      await page.waitForFunction(() => !document.querySelector("#entry").disabled, null, { timeout: 60000 });
      await page.waitForTimeout(100);
    }
    if (shot.after) await shot.after(page);
    // let the whole transcript show in the capture instead of the scrolled view
    await page.addStyleTag({ content: "#thread{height:auto!important;max-height:none!important}" });
    await page.waitForTimeout(150);
    if (shot.panel) await page.locator(".panel").first().screenshot({ path: shot.panel });
    await page.screenshot({ path: `screenshots/${shot.name}.png`, fullPage: true });
    console.log("captured " + shot.name);
    await page.close();
  }
  await browser.close();
})();
