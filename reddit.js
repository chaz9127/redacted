// Redactor — Reddit content script (shared helpers live in common.js)
// For any post whose title contains a blocklisted keyword: replace the title
// text with "[REDACTED]" and cover its thumbnail / media / text preview with a
// black "[REDACTED]" placeholder. Removing the keyword restores both.
//
// Covers new Reddit (<shreddit-post> web components), old.reddit.com
// (.thing.link), and — through a generic pass over links to /comments/ —
// post titles shown elsewhere (search results, "recent posts", etc).
//
// Media is hidden with CSS keyed off a marker attribute on the post rather
// than by editing <img> sources: Reddit's media lives partly inside web
// components' shadow DOM, which a stylesheet overlay covers but DOM edits
// can't reach. Restoring is then just removing the marker.

const MARK = "data-rdr-redacted"; // on a post card: hide its media
const IMG_MARK = "data-rdr-img"; // on a loose <img>: swap it for the placeholder
const TITLE_MARK = "data-rdr-title"; // on a redacted title element
const HL_MARK = "data-rdr-hl"; // on a community-highlight card we've set up

// Post cards and their title element.
const POSTS = [
  { card: "shreddit-post", title: '[slot="title"]' }, // new Reddit
  { card: ".thing.link", title: "a.title" }, // old Reddit
];
const POST_CARD_SEL = POSTS.map((p) => p.card).join(",");

// Images that are never post thumbnails (community icons, user avatars).
const AVATAR_SEL = [
  '[class*="avatar" i]',
  '[class*="icon" i]',
  'a[href^="/user/"]',
  'a[href^="/u/"]',
  'a[href^="/r/"]:not([href*="/comments/"])',
].join(",");

// Original title nodes, so restoring brings back the exact markup (new
// Reddit titles can contain nested spans), not just the text.
const origTitle = new WeakMap();

const PLACEHOLDER_PNG = chrome.runtime.getURL("images/redacted-video.png");
const PLACEHOLDER_BG = `url("${PLACEHOLDER_PNG}"), url("${redactedImage(1280, 720)}")`;

function injectStyles() {
  if (document.getElementById("rdr-style")) return;
  const png = PLACEHOLDER_PNG;
  const bg = PLACEHOLDER_BG;
  // Media regions to cover inside a redacted post.
  const media = [
    '[slot="thumbnail"]',
    '[slot="post-media-container"]',
    '[slot="text-body"]',
    "a.thumbnail", // old Reddit
    ".expando", // old Reddit, expanded media / self text
  ]
    .map((m) => `[${MARK}] ${m}`)
    .join(",\n    ");
  const style = document.createElement("style");
  style.id = "rdr-style";
  style.textContent = `
    ${media} {
      position: relative !important;
      min-height: 48px;
    }
    ${media.replace(/,\n/g, "::after,\n")}::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 100;
      background-color: #000;
      background-image: ${bg};
      background-repeat: no-repeat, no-repeat;
      background-position: center, center;
      background-size: contain, contain;
      border-radius: inherit;
      pointer-events: auto;
    }
    img[${IMG_MARK}] {
      content: url("${png}");
      object-fit: cover;
      background: #000;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// Decide one title element. `onChange(redacted)` applies/clears the media
// treatment for whatever surrounds this title.
function processTitle(el, onChange) {
  const orig = origTitle.get(el);
  const text = (el.textContent || "").trim();

  if (orig && text === REDACTED_TEXT) {
    const origText = orig.text;
    if (titleMatches(origText)) {
      onChange(true); // still matching; keep media hidden
    } else {
      if (DEBUG()) console.debug(`[RDR] restoring: "${origText}"`);
      el.replaceChildren(...orig.nodes);
      restoreAttr(el, "title", origText);
      restoreAttr(el, "aria-label", origText);
      origTitle.delete(el);
      el.removeAttribute(TITLE_MARK);
      onChange(false);
    }
    return;
  }

  if (titleMatches(text)) {
    if (DEBUG()) console.debug(`[RDR] redacting: "${text}"`);
    origTitle.set(el, { text, nodes: Array.from(el.childNodes) });
    setRedacted(el);
    el.setAttribute(TITLE_MARK, "");
    onChange(true);
  } else if (orig) {
    // Reddit re-rendered this node with a different, non-matching title.
    origTitle.delete(el);
    el.removeAttribute(TITLE_MARK);
    onChange(false);
  }
}

function restoreAttr(el, name, value) {
  if (el.getAttribute(name) === REDACTED_TEXT) el.setAttribute(name, value);
}

function setMark(el, on) {
  if (on) {
    if (!el.hasAttribute(MARK)) el.setAttribute(MARK, "");
  } else {
    el.removeAttribute(MARK);
  }
}

// --- Generic pass: title links outside a known post card -------------------

function postId(href) {
  const m = /\/comments\/([a-z0-9]+)/i.exec(href || "");
  return m ? m[1] : null;
}

// The smallest-but-complete wrapper around one post's links: climb from the
// title link while the ancestor still only links to this one post.
function looseCard(link, id) {
  let card = link;
  for (let i = 0, n = link.parentElement; i < 6 && n && n !== document.body; i++, n = n.parentElement) {
    const others = n.querySelectorAll('a[href*="/comments/"]');
    if (Array.from(others).some((a) => postId(a.getAttribute("href")) !== id)) break;
    card = n;
  }
  return card;
}

function markLooseImages(card, on) {
  if (on) {
    card.querySelectorAll("img").forEach((img) => {
      if (!img.closest(AVATAR_SEL)) img.setAttribute(IMG_MARK, "");
    });
  } else {
    card.querySelectorAll(`img[${IMG_MARK}]`).forEach((img) => img.removeAttribute(IMG_MARK));
  }
}

function looseTitleLinks(root) {
  const out = [];
  root.querySelectorAll('a[href*="/comments/"]').forEach((a) => {
    if (a.closest(`${POST_CARD_SEL}, [${HL_MARK}], shreddit-comment, .thing.comment, .commentarea`)) return;
    if (a.querySelector("img")) return; // a thumbnail link, not a title
    if (a.querySelector(`[${HL_MARK}]`)) return; // wraps a highlight card
    if (!(a.textContent || "").trim()) return;
    out.push(a);
  });
  return out;
}

// --- Community highlights -------------------------------------------------
// The cards at the top of a subreddit. Each is a web component: the title is
// passed in through a light-DOM [slot="title"] child (so we can redact it like
// any title), but the thumbnail is a CSS background inside the card's shadow
// root, out of reach of our page stylesheet. So we add a rule *inside* the
// shadow root that swaps that background whenever the host carries MARK.
// Cards are found by structure, not tag name: a [slot="title"] whose parent's
// shadow root contains .highlight-card.

function highlightCards(root) {
  const cards = new Set();
  root.querySelectorAll('[slot="title"]').forEach((t) => {
    const host = t.parentElement;
    if (!host || host.closest(POST_CARD_SEL)) return;
    if (host.hasAttribute(HL_MARK) || host.shadowRoot?.querySelector(".highlight-card")) {
      cards.add(host);
    }
  });
  return cards;
}

function prepareHighlight(host) {
  host.setAttribute(HL_MARK, "");
  const sr = host.shadowRoot;
  if (!sr || sr.querySelector("style[data-rdr]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-rdr", "");
  style.textContent = `
    :host([${MARK}]) .thumbnail-img {
      background-color: #000 !important;
      background-image: ${PLACEHOLDER_BG} !important;
      background-repeat: no-repeat, no-repeat !important;
      background-position: center, center !important;
      background-size: contain, contain !important;
    }
  `;
  sr.appendChild(style);
}

// --- Scan ------------------------------------------------------------------

function scan(root = document) {
  // Nothing to do only when there are no keywords AND nothing is redacted;
  // if something is, we must still run so it can be restored.
  if (keywords.length === 0 && !document.querySelector(`[${TITLE_MARK}]`)) {
    return;
  }

  for (const { card, title } of POSTS) {
    root.querySelectorAll(card).forEach((c) => {
      const titles = c.querySelectorAll(title);
      if (!titles.length) return;
      // A card is hidden if any of its title elements matches.
      let any = false;
      titles.forEach((t) => processTitle(t, (on) => (any = any || on)));
      setMark(c, any);
    });
  }

  highlightCards(root).forEach((host) => {
    const title = host.querySelector(':scope > [slot="title"]');
    if (!title) return;
    if (!host.hasAttribute(HL_MARK)) {
      if (!titleMatches((title.textContent || "").trim())) return; // untouched until needed
      prepareHighlight(host);
    }
    processTitle(title, (on) => setMark(host, on));
  });

  looseTitleLinks(root).forEach((a) => {
    const id = postId(a.getAttribute("href"));
    processTitle(a, (on) => markLooseImages(looseCard(a, id), on));
  });
}

injectStyles();
runRedactor("reddit", scan);
