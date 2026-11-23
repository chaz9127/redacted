// Redactor — shared helpers used by every site's content script.
// Loaded before the site script (see manifest.json), so these are globals.

const REDACTED_TEXT = "[REDACTED]";

// A black "[REDACTED]" placeholder image, generated as an inline SVG data URI.
// Used as a fallback until the bundled PNGs (images/redacted-*.png) load.
function redactedImage(w, h) {
  const fontSize = w >= h ? 150 : 130;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="black"/>` +
    `<text x="50%" y="50%" fill="white" ` +
    `font-family="Arial, Helvetica, sans-serif" font-weight="bold" ` +
    `font-size="${fontSize}" text-anchor="middle" ` +
    `dominant-baseline="central">[REDACTED]</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// Toggle logging from the page console: `localStorage.ytrDebug = 1` then reload.
const DEBUG = () => {
  try {
    return localStorage.getItem("ytrDebug") === "1";
  } catch (e) {
    return false;
  }
};

let keywords = [];
let keywordPatterns = [];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build case-insensitive whole-word/phrase matchers. A keyword only matches
// when bounded by non-alphanumeric characters (or string edges), so "doom"
// matches the word "doom" but not "doomsday". Multi-word keywords match as a
// whole phrase.
function setKeywords(list) {
  keywords = (list || []).map((k) => String(k).trim()).filter(Boolean);
  keywordPatterns = keywords.map(
    (kw) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(kw)}(?![\\p{L}\\p{N}])`, "iu")
  );
}

// Per-site on/off switches, set from the popup's settings panel and stored as
// { sites: { youtube: false, ... } }. A site missing from the map is ENABLED,
// so every site is on by default (and for users upgrading from before the
// setting existed). A disabled site simply behaves as if the keyword list were
// empty, which makes each scan restore anything it had redacted.
let rawKeywords = [];
let siteEnabled = true;

function applySettings() {
  setKeywords(siteEnabled ? rawKeywords : []);
}

function loadSettings(site) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ keywords: [], sites: {} }, (data) => {
      rawKeywords = data.keywords || [];
      siteEnabled = (data.sites || {})[site] !== false;
      applySettings();
      resolve();
    });
  });
}

function titleMatches(text) {
  if (!text) return false;
  return keywordPatterns.some((re) => re.test(text));
}

function setRedacted(el) {
  if (el.textContent !== REDACTED_TEXT) el.textContent = REDACTED_TEXT;
  if (el.getAttribute("title") !== null) el.setAttribute("title", REDACTED_TEXT);
  if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", REDACTED_TEXT);
}

// Load settings, run `scan` once, then re-run it (debounced to one per frame)
// on every DOM change and whenever the keyword list or site switches change.
// `site` is this script's key in the popup's site list (e.g. "youtube").
function runRedactor(site, scan) {
  let scheduled = false;
  const scheduleScan = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  };

  loadSettings(site).then(() => {
    scan();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(changes.keywords || changes.sites)) return;
      if (changes.keywords) rawKeywords = changes.keywords.newValue || [];
      if (changes.sites) siteEnabled = (changes.sites.newValue || {})[site] !== false;
      applySettings();
      scan();
    });
  });
}
