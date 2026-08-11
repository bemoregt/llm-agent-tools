const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

// Reuses the Brave already installed on this Mac (via its real DevTools
// protocol, not the unreliable `--screenshot` CLI flag - that flag hung
// indefinitely in testing against a JS-heavy page like Windy's map) instead
// of pulling down puppeteer's own bundled Chromium.
const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

const WINDY_RAIN_URL = 'https://www.windy.com/ko/-%EB%B9%84-%EB%B2%88%EA%B0%9C-rain?rain,35.908,129.612,4';

const CONSENT_SELECTORS = [
  'button[aria-label="Accept all"]',
  'button[aria-label="Agree"]',
  '.fc-cta-consent',
  '#didomi-notice-agree-button',
  'button.accept-all',
];

async function dismissConsent(page) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        return;
      }
    } catch {
      // selector not present or not clickable - try the next one
    }
  }
}

// Captures the Windy.com rain-radar view as a PNG buffer. A fresh temp
// profile per call (not the user's real Brave profile - launching headless
// against an already-open default profile would conflict with the user's
// actual running browser) is created and torn down around the capture.
async function captureWindyRain() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-windy-'));
  const browser = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    userDataDir: profileDir,
    args: ['--window-size=1280,900', '--no-sandbox', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(WINDY_RAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await dismissConsent(page);
    // Map tiles/radar animation keep loading briefly after networkidle -
    // a short fixed wait lets them settle before the shot.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return await page.screenshot({ type: 'png' });
  } finally {
    await browser.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 900;
// Bounds how many viewport-sized shots a single capture can produce, so a
// page with infinite scroll (social feeds, etc.) can't run forever.
const MAX_CAPTURE_SHOTS = 20;

// Captures an arbitrary URL as a sequence of viewport-sized PNG screenshots,
// scrolling down a full viewport height between each one - unlike
// puppeteer's built-in `fullPage: true`, which stitches everything into a
// single (sometimes huge, sometimes broken-on-sticky-headers) image, this
// mirrors what a person would actually see scrolling through the page.
async function captureFullPageScroll(url) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-webcapture-'));
  const browser = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    userDataDir: profileDir,
    args: [`--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`, '--no-sandbox', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await dismissConsent(page);
    // Lets lazy-loaded images/fonts/animations settle before the first shot.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const shots = [];
    for (let i = 0; i < MAX_CAPTURE_SHOTS; i += 1) {
      shots.push(await page.screenshot({ type: 'png' }));

      // Scrolls one viewport further and reports whether it actually moved
      // (i.e. whether the previous shot was already the bottom of the page).
      const moved = await page.evaluate((step) => {
        const doc = document.documentElement;
        const before = window.scrollY;
        const maxScroll = doc.scrollHeight - window.innerHeight;
        if (before >= maxScroll - 1) return false;
        window.scrollBy(0, step);
        return true;
      }, CAPTURE_HEIGHT);

      if (!moved) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return shots;
  } finally {
    await browser.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

module.exports = { captureWindyRain, captureFullPageScroll };
