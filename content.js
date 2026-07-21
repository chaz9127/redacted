// YouTube Title Redactor — content script
// For any video whose title contains a blocklisted keyword: replace the title
// text with "[REDACTED]" and swap the thumbnail image for a black "[REDACTED]"
// placeholder. Removing the keyword restores both.
//
// Design notes:
//  - Decisions are made from each element's CURRENT text every pass, because
//    YouTube's Polymer/lit layers re-render and recycle DOM nodes as you
//    scroll. Everything here is idempotent and driven by a MutationObserver.

const REDACTED_TEXT = "[REDACTED]";

// Elements that hold a video title across YouTube's various layouts.
const TITLE_SELECTORS = [
  "#video-title",
  "a#video-title-link",
  "yt-formatted-string#video-title",
  ".yt-lockup-metadata-view-model-wiz__title", // new lockup layout
  "h1.ytd-watch-metadata yt-formatted-string", // watch page
  ".shortsLockupViewModelHostMetadataTitle span", // shorts
  ".ytp-title-link", // in-player title
];

// Renderer containers that group a title with its thumbnail.
const CONTAINER_SELECTORS = [
  "yt-lockup-view-model",
  "ytd-rich-item-renderer",
  "ytd-rich-grid-media",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-playlist-video-renderer",
  "ytd-playlist-panel-video-renderer",
  "ytd-reel-item-renderer",
  "ytm-shorts-lockup-view-model",
  "ytm-shorts-lockup-view-model-v2",
  "ytd-shorts",
];

// Shorts-style (portrait) containers, used to pick a placeholder orientation.
const SHORTS_SELECTORS = ["ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2", "ytd-reel-item-renderer", "ytd-shorts"];

// Positive markers for a *video thumbnail* image. An image is only ever
// swapped if it sits inside one of these — this is what keeps channel avatars
// safe: avatars link to /@channel (never /watch or /shorts) and are not inside
// a thumbnail wrapper, so they never match here regardless of avatar markup.
const THUMB_WRAPPER_SELECTORS = [
  "ytd-thumbnail",
  "a#thumbnail",
  "yt-thumbnail-view-model",
  "ytd-thumbnail-view-model",
  '[class*="ThumbnailViewModel"]',
  '[class*="shortsLockupViewModelHostThumbnail"]',
  '[class*="ShortsLockupViewModelHostThumbnail"]',
  'a[href*="/watch?v="]',
  'a[href*="/shorts/"]',
];

// Channel-avatar / channel-link images — an extra explicit guard on top of the
// positive thumbnail check above.
const AVATAR_SELECTORS = [
  "#avatar",
  "#avatar-link",
  "ytd-channel-avatar",
  "yt-img-shadow#avatar",
  "#channel-thumbnail",
  ".yt-spec-avatar-shape",
  '[class*="AvatarViewModel"]',
  '[class*="avatar"]',
  'a[href^="/@"]',
  'a[href^="/channel/"]',
  'a[href^="/c/"]',
  'a[href^="/user/"]',
];

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

const SVG_PREFIX = "data:image/svg+xml,";
const EXT_IMG_PREFIX = chrome.runtime.getURL("images/");

// Resolved placeholder URLs. Default to the SVG; a probe (see start) upgrades
// these to your bundled PNGs if they exist.
let placeholderLandscape = redactedImage(1280, 720);
let placeholderPortrait = redactedImage(1080, 1920);

function isPlaceholder(src) {
  return src.startsWith(SVG_PREFIX) || src.startsWith(EXT_IMG_PREFIX);
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

function loadKeywords() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ keywords: [] }, (data) => {
      keywords = (data.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
      resolve();
    });
  });
}

function titleMatches(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function findContainer(el) {
  for (const sel of CONTAINER_SELECTORS) {
    const c = el.closest(sel);
    if (c) return c;
  }
  return null;
}

// Is this title part of a Short? Shorts are handled via a CSS marker rather
// than an img-src swap (see the Shorts branch in processTitleElement).
function isShort(el) {
  return !!el.closest(`${SHORTS_SELECTORS.join(",")}, a[href*="/shorts/"]`);
}

// Video-thumbnail images in a card, excluding channel avatars. Requires a
// positive thumbnail marker so channel avatars are never swapped.
function videoThumbImgs(scope) {
  const thumbSel = THUMB_WRAPPER_SELECTORS.join(",");
  const avatarSel = AVATAR_SELECTORS.join(",");
  return Array.from(scope.querySelectorAll("img")).filter((img) => img.closest(thumbSel) && !img.closest(avatarSel));
}

function isPortrait(img) {
  const w = img.clientWidth;
  const h = img.clientHeight;
  return !!(w && h) && h > w;
}

function redactThumbnails(scope) {
  if (!scope) return;
  videoThumbImgs(scope).forEach((img) => {
    const src = img.getAttribute("src");
    // Remember the latest REAL src (never our own placeholder) so we can
    // restore it later; handles YouTube recycling nodes between videos.
    if (src && !isPlaceholder(src)) {
      img.setAttribute("data-ytr-orig-src", src);
    }
    const placeholder = isPortrait(img) ? placeholderPortrait : placeholderLandscape;
    if (img.getAttribute("src") !== placeholder) {
      img.setAttribute("src", placeholder);
    }
    img.removeAttribute("srcset"); // stop the browser overriding src
  });
}

function restoreThumbnails(scope) {
  if (!scope) return;
  scope.querySelectorAll("img[data-ytr-orig-src]").forEach((img) => {
    img.setAttribute("src", img.getAttribute("data-ytr-orig-src"));
    img.removeAttribute("data-ytr-orig-src");
  });
}

function setRedacted(el) {
  if (el.textContent !== REDACTED_TEXT) el.textContent = REDACTED_TEXT;
  if (el.getAttribute("title") !== null) el.setAttribute("title", REDACTED_TEXT);
  if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", REDACTED_TEXT);
}

function restoreTitle(el, orig) {
  if (orig) {
    el.textContent = orig;
    if (el.getAttribute("title") === REDACTED_TEXT) el.setAttribute("title", orig);
    if (el.getAttribute("aria-label") === REDACTED_TEXT) {
      el.setAttribute("aria-label", orig);
    }
  }
}

// Original titles for redacted Shorts, kept in a WeakMap rather than a DOM
// attribute: the Shorts title lives in lit-managed DOM that strips foreign
// attributes, but a Map entry keyed by the element survives.
const shortOrig = new WeakMap();

// Shorts get the same title redaction as videos, but the thumbnail is hidden
// with a CSS marker (markShort/unmarkShort) instead of an img-src swap, and the
// original title is tracked in shortOrig instead of a data-* attribute.
function processShort(el, text) {
  const orig = shortOrig.get(el);

  if (titleMatches(text)) {
    if (DEBUG()) console.debug(`[YTR] redacting short: "${text}"`);
    shortOrig.set(el, text);
    setRedacted(el);
    markShort(el);
  } else if (text === REDACTED_TEXT && orig && titleMatches(orig)) {
    // Still ours and still matching; re-apply in case the text was reverted.
    setRedacted(el);
    markShort(el);
  } else {
    // Non-matching real title (recycled node), or keyword removed. Restore the
    // text if we own it, then clear our marks.
    if (text === REDACTED_TEXT && orig) restoreTitle(el, orig);
    shortOrig.delete(el);
    unmarkShort(el);
  }
}

function restore(el, orig) {
  restoreTitle(el, orig);
  el.removeAttribute("data-ytr-orig-title");
  restoreThumbnails(findContainer(el));
}

function processTitleElement(el) {
  const text = (el.textContent || el.getAttribute("title") || "").trim();

  if (isShort(el)) {
    processShort(el, text);
    return;
  }

  if (titleMatches(text)) {
    // A real, matching title is visible: remember it, redact it, hide its thumb.
    el.setAttribute("data-ytr-orig-title", text);
    if (DEBUG()) console.debug(`[YTR] redacting: "${text}"`);
    setRedacted(el);
    redactThumbnails(findContainer(el));
    return;
  }

  if (text === REDACTED_TEXT) {
    const orig = el.getAttribute("data-ytr-orig-title");
    if (orig && titleMatches(orig)) {
      // Still hidden (YouTube hasn't rebound this node); keep the thumb hidden
      // in case it was lazily reloaded.
      redactThumbnails(findContainer(el));
    } else {
      // The keyword that hid this was removed — put the real title/thumb back.
      if (DEBUG()) console.debug(`[YTR] restoring: "${orig}"`);
      restore(el, orig);
    }
  }
  // Otherwise: a real non-matching title (or a recycled node) — leave it alone.
}

// Collect every element that plausibly holds a video title, from both the
// explicit selectors and a generic pass over links to videos. The generic pass
// survives YouTube renaming CSS classes: a title link points at a /watch or
// /shorts URL and carries text (a *thumbnail* link wraps an <img> and has no
// text), which lets us tell the two apart.
function collectTitleElements(root) {
  const els = new Set();

  for (const sel of TITLE_SELECTORS) {
    root.querySelectorAll(sel).forEach((e) => els.add(e));
  }

  root.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]').forEach((a) => {
    const txt = (a.textContent || "").trim();
    if (txt && !a.querySelector("img")) els.add(a);
  });

  // Keep only the OUTERMOST of any nested matches. A Short's title matches both
  // as the title <a> and as the <span> inside it; processing both makes them
  // fight (one redacts + marks, the other sees "[REDACTED]" and unmarks). One
  // element per title avoids that.
  const arr = Array.from(els);
  return arr.filter((el) => !arr.some((other) => other !== el && other.contains(el)));
}

function scan(root = document) {
  // Nothing to do only when there are no keywords AND nothing is redacted
  // (videos set data-ytr-orig-title; Shorts set data-ytr-short). If a redaction
  // exists we must still run so it can be restored.
  if (
    keywords.length === 0 &&
    !document.querySelector("[data-ytr-orig-title], [data-ytr-short]")
  ) {
    return;
  }
  const els = collectTitleElements(root);
  if (DEBUG()) {
    console.debug(`[YTR] scan: ${els.length} title candidates, keywords=[${keywords.join(", ")}]`);
  }
  els.forEach(processTitleElement);
}

// Debounced re-scan for dynamically loaded / re-rendered content.
let scheduled = false;
function scheduleScan() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    scan();
  });
}

// Use the bundled PNGs if they exist; otherwise keep the SVG fallback. We
// probe by loading them — a missing file fires onerror and we simply keep the
// SVG, so the extension works whether or not the images are present.
function resolvePlaceholders() {
  const tryLoad = (url, apply) => {
    const im = new Image();
    im.onload = () => {
      apply(url);
      scan(); // re-swap any already-redacted thumbs to the real image
    };
    im.src = url;
  };
  tryLoad(chrome.runtime.getURL("images/redacted-video.png"), (u) => {
    placeholderLandscape = u;
  });
  tryLoad(chrome.runtime.getURL("images/redacted-short.png"), (u) => {
    placeholderPortrait = u;
  });
}

// Shorts get a different treatment than regular videos. Swapping a Short's
// thumbnail `src` fails: YouTube reactively reverts it, causing constant
// flashing. Instead we paint the portrait placeholder over the Short with a
// CSS rule (injected into <head>, which YouTube never reconciles) keyed off a
// marker attribute on a stable, non-lit ancestor. Nothing on the Short's own
// (lit-managed) DOM is modified, so there is nothing for YouTube to fight.
function injectStyles() {
  if (document.getElementById("ytr-style")) return;
  const png = chrome.runtime.getURL("images/redacted-short.png");
  const svg = redactedImage(1080, 1920); // fallback if the PNG isn't present
  const style = document.createElement("style");
  style.id = "ytr-style";
  style.textContent = `
    [data-ytr-short] { position: relative !important; }
    [data-ytr-short]::after {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      /* Cover only the thumbnail (Shorts thumbs are 9:16), not the title. */
      aspect-ratio: 2 / 3;
      z-index: 100;
      background-color: #000;
      background-image: url("${png}"), url("${svg}");
      background-repeat: no-repeat, no-repeat;
      background-position: center, center;
      background-size: cover, cover;
      pointer-events: none;
      border-radius: 8px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

const SHORT_LOCKUP_SELECTOR =
  "ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer";

// The element to mark for a Short. It must live OUTSIDE lit's managed DOM, or
// the marker gets stripped: a Short is a stack of nested lit hosts
// (ytm-shorts-lockup-view-model-v2 > ytm-shorts-lockup-view-model > …), and
// editing the title makes lit re-render them. So we find the OUTERMOST shorts
// lockup and climb past every `*-view-model` to the first normal wrapper
// (e.g. div#content / ytd-rich-item-renderer), which renders a box, wraps this
// one Short, and lit never touches.
function shortCard(el) {
  let lockup = null;
  for (let n = el; n; n = n.parentElement) {
    if (n.matches && n.matches(SHORT_LOCKUP_SELECTOR)) lockup = n; // keep climbing → outermost
  }
  if (lockup) {
    let card = lockup.parentElement;
    while (card && /view-model/i.test(card.tagName)) card = card.parentElement;
    return card || lockup;
  }
  return (
    el.closest("ytd-rich-item-renderer, ytd-grid-video-renderer") ||
    findContainer(el) ||
    el
  );
}

function markShort(el) {
  const card = shortCard(el);
  if (card && card.getAttribute("data-ytr-short") !== "1") {
    card.setAttribute("data-ytr-short", "1");
  }
}

function unmarkShort(el) {
  const card = shortCard(el);
  if (card) card.removeAttribute("data-ytr-short");
}

function start() {
  injectStyles();
  resolvePlaceholders();
  scan();

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.keywords) {
      keywords = (changes.keywords.newValue || []).map((k) => String(k).toLowerCase()).filter(Boolean);
      scan();
    }
  });
}

loadKeywords().then(start);
