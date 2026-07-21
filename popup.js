const addForm = document.getElementById("add-form");
const keywordInput = document.getElementById("keyword-input");
const searchInput = document.getElementById("search-input");
const list = document.getElementById("keyword-list");
const emptyMsg = document.getElementById("empty-msg");

let keywords = [];

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
