const { chromium } = require("playwright");
const path = require("path");

const shots = [
  { name: "01-delivered-but-missing", steps: ["EG-58120", "I already checked", "Refund me"] },
  { name: "02-error-handling",        steps: ["where is my stuff", "EG-99999"] },
  { name: "03-in-transit-not-lost",   steps: ["EG-77441", "Notify me when it arrives"] },
];

(async () => {
  const browser = await chromium.launch();
  for (const shot of shots) {
    const page = await browser.newPage({ viewportSize: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    await page.goto("file://" + path.resolve("public/index.html"));
    for (const s of shot.steps) {
      await page.fill("#entry", s);
      await page.click("button[type=submit]");
      await page.waitForFunction(() => !document.querySelector("#entry").disabled);
      await page.waitForTimeout(100);
    }
    // let the whole transcript show in the capture instead of the scrolled view
    await page.addStyleTag({ content: "#thread{height:auto!important;max-height:none!important}" });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `screenshots/${shot.name}.png`, fullPage: true });
    console.log("captured " + shot.name);
    await page.close();
  }
  await browser.close();
})();
