const fs = require('fs');
const path = require('path');

// Click counts are app state, not wiki content, so they live alongside the
// server code rather than in the Obsidian vault.
const STORE_PATH = path.join(__dirname, '..', 'data', 'link-clicks.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(counts) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(counts, null, 2), 'utf8');
}

function recordClick(url) {
  if (!url) return 0;
  const counts = load();
  counts[url] = (counts[url] || 0) + 1;
  save(counts);
  return counts[url];
}

function getCounts() {
  return load();
}

module.exports = { recordClick, getCounts };
