const addForm = document.getElementById("add-form");
const keywordInput = document.getElementById("keyword-input");
const searchInput = document.getElementById("search-input");
const list = document.getElementById("keyword-list");
const emptyMsg = document.getElementById("empty-msg");

let keywords = [];

// Sites the extension runs on. `id` must match the name each content script
// passes to runRedactor(). A site missing from storage counts as enabled.
const SITES = [
  { id: "youtube", label: "YouTube" },
  { id: "reddit", label: "Reddit" },
];

const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const siteList = document.getElementById("site-list");

let sites = {};

function loadSites() {
  chrome.storage.local.get({ sites: {} }, (data) => {
    sites = data.sites || {};
    renderSites();
  });
}

function renderSites() {
  siteList.innerHTML = "";
  for (const site of SITES) {
    const label = document.createElement("label");
    label.className = "site-option";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = sites[site.id] !== false;
    box.addEventListener("change", () => {
      sites = { ...sites, [site.id]: box.checked };
      chrome.storage.local.set({ sites });
    });

    label.appendChild(box);
    label.appendChild(document.createTextNode(site.label));
    siteList.appendChild(label);
  }
}

settingsBtn.addEventListener("click", () => {
  const open = settingsPanel.hidden;
  settingsPanel.hidden = !open;
  settingsBtn.setAttribute("aria-expanded", String(open));
});

function loadKeywords() {
  chrome.storage.local.get({ keywords: [] }, (data) => {
    keywords = data.keywords || [];
    render();
  });
}

function saveKeywords() {
  chrome.storage.local.set({ keywords });
}

function addKeyword(raw) {
  const value = raw.trim();
  if (!value) return;
  // Case-insensitive de-duplication.
  const exists = keywords.some((k) => k.toLowerCase() === value.toLowerCase());
  if (exists) return;
  keywords.push(value);
  saveKeywords();
  render();
}

function removeKeyword(value) {
  keywords = keywords.filter((k) => k !== value);
  saveKeywords();
  render();
}

function render() {
  const filter = searchInput.value.trim().toLowerCase();
  const visible = keywords.filter((k) => k.toLowerCase().includes(filter));

  list.innerHTML = "";

  if (keywords.length === 0) {
    emptyMsg.textContent = "No keywords yet.";
    emptyMsg.style.display = "block";
    return;
  }
  if (visible.length === 0) {
    emptyMsg.textContent = "No matches.";
    emptyMsg.style.display = "block";
    return;
  }
  emptyMsg.style.display = "none";

  for (const kw of visible) {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.className = "kw-text";
    span.textContent = kw;

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.type = "button";
    btn.textContent = "×"; // ×
    btn.title = "Remove";
    btn.setAttribute("aria-label", `Remove ${kw}`);
    btn.addEventListener("click", () => removeKeyword(kw));

    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  addKeyword(keywordInput.value);
  keywordInput.value = "";
  keywordInput.focus();
});

searchInput.addEventListener("input", render);

loadKeywords();
loadSites();
