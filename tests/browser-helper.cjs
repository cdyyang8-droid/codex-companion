const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.resolve(__dirname, '../outputs'), { recursive: true });
const base = process.env.COMPANION_TEST_URL || 'http://127.0.0.1:18377';
const launchBrowser = () => chromium.launch({
  headless: true,
  ...(process.env.COMPANION_CHROME_PATH ? { executablePath: process.env.COMPANION_CHROME_PATH } : {}),
});
module.exports = { base, launchBrowser };
