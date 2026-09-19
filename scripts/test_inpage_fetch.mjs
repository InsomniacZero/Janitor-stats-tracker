import { chromium } from "playwright";

async function main() {
  const charId = "e7ce009c-0f80-4279-a16f-044e9aab63a4";
  let execPath = "/home/insomniac/.cache/ms-playwright/chromium-1148/chrome-linux/chrome";

  const browser = await chromium.launch({
    headless: true,
    executablePath: execPath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  console.log("Navigating to home page https://janitorai.com/ ...");
  await page.goto("https://janitorai.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(3000);

  console.log("Calling fetch inside page.evaluate...");
  const result = await page.evaluate(async (cid) => {
    try {
      const res = await fetch(`/hampter/characters/${cid}`, {
        headers: { Accept: "application/json" }
      });
      return { status: res.status, ok: res.ok, data: await res.json().catch(() => null) };
    } catch (e) {
      return { error: e.message };
    }
  }, charId);

  console.log("In-page fetch result:", JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch(console.error);
