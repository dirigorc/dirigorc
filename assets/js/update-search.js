(() => {
  const INDEX_URL = "/updates/search.json";
  const MIN_QUERY_LENGTH = 2;

  const toggle = document.querySelector(".search-toggle");
  const panel = document.querySelector("#updates-search-panel");
  const form = document.querySelector(".search-shell");
  const input = document.querySelector("#updates-search");
  const defaultView = document.querySelector(".updates-default-view");
  const resultsRoot = document.querySelector("#search-results");
  const count = document.querySelector("#search-count");
  const clearButton = document.querySelector(".search-clear");

  if (!toggle || !panel || !form || !input || !defaultView || !resultsRoot || !count || !clearButton) {
    return;
  }

  const state = {
    updates: [],
    query: "",
    indexLoaded: false,
  };

  const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));

  const normalize = (value) => String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const slugify = (value) => normalize(value)
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const tokenize = (value) => normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_QUERY_LENGTH);

  const buildHaystack = (update) => [
    update.title,
    update.category,
    update.stat,
    update.summary,
    ...(update.tags || []),
    ...(update.links || []).map((link) => link.label),
  ].join(" ");

  const prepareUpdate = (update) => ({
    ...update,
    _haystack: normalize(buildHaystack(update)),
    _title: normalize(update.title),
    _tags: normalize((update.tags || []).join(" ")),
    _category: normalize(update.category),
  });

  const scoreUpdate = (update, terms, query) => {
    if (!terms.length) {
      return 0;
    }

    let score = 0;
    for (const term of terms) {
      if (update._title.includes(term)) score += 10;
      if (update._tags.includes(term)) score += 7;
      if (update._category.includes(term)) score += 4;
      if (update._haystack.includes(term)) score += 2;
    }

    if (update._haystack.includes(query)) {
      score += 12;
    }

    return score;
  };

  const highlightEscaped = (escapedText, terms) => {
    const safeTerms = terms
      .filter((term) => term.length >= MIN_QUERY_LENGTH)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    if (!safeTerms.length) {
      return escapedText;
    }

    const pattern = new RegExp(`(${safeTerms.join("|")})`, "gi");
    return escapedText.replace(pattern, "<mark>$1</mark>");
  };

  const highlight = (text, terms) => highlightEscaped(escapeHtml(text), terms);

  const tagRegex = (tags) => {
    const usefulTags = (tags || [])
      .filter((tag) => String(tag).length >= MIN_QUERY_LENGTH)
      .sort((a, b) => String(b).length - String(a).length)
      .map((tag) => String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    if (!usefulTags.length) {
      return null;
    }

    return new RegExp(`\\b(${usefulTags.join("|")})\\b`, "giu");
  };

  const renderLinkedSummary = (summary, tags, terms) => {
    const pattern = tagRegex(tags);
    if (!pattern) {
      return highlight(summary, terms);
    }

    let output = "";
    let cursor = 0;

    for (const match of String(summary || "").matchAll(pattern)) {
      const matchedText = match[0];
      const index = match.index || 0;
      const tag = (tags || []).find((candidate) => normalize(candidate) === normalize(matchedText));

      output += highlight(String(summary).slice(cursor, index), terms);

      if (tag) {
        output += `<a class="tag-inline" href="/updates/tags/${slugify(tag)}/">${highlight(matchedText, terms)}</a>`;
      } else {
        output += highlight(matchedText, terms);
      }

      cursor = index + matchedText.length;
    }

    output += highlight(String(summary).slice(cursor), terms);
    return output;
  };

  const renderLinks = (links) => {
    if (!links || !links.length) {
      return "";
    }

    return `
      <p class="activity-links">
        ${links.map((link) => `
          <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>
        `).join("")}
      </p>
    `;
  };

  const renderResults = (matches, terms) => {
    resultsRoot.innerHTML = matches.map(({ update }) => `
      <article class="activity-item search-result">
        <p class="activity-meta">
          <span>${escapeHtml(update.category || "Update")}</span>
          <time datetime="${escapeHtml(update.date)}">${escapeHtml(update.displayDate || update.date)}</time>
        </p>
        <div>
          ${update.stat ? `<p class="result-pill">${highlight(update.stat, terms)}</p>` : ""}
          <h2>${highlight(update.title, terms)}</h2>
          <p>${renderLinkedSummary(update.summary, update.tags, terms)}</p>
          ${renderLinks(update.links)}
        </div>
      </article>
    `).join("");
  };

  const setUrlQuery = (query) => {
    const url = new URL(window.location.href);
    if (query) {
      url.searchParams.set("q", query);
    } else {
      url.searchParams.delete("q");
    }
    window.history.replaceState({}, "", url);
  };

  const showSearch = ({ focus = true } = {}) => {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    if (focus) {
      input.focus();
    }
  };

  const hideSearch = () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };

  const showDefaultView = () => {
    defaultView.hidden = false;
    resultsRoot.hidden = true;
    resultsRoot.innerHTML = "";
  };

  const showResultsView = () => {
    defaultView.hidden = true;
    resultsRoot.hidden = false;
  };

  const loadIndex = async () => {
    if (state.indexLoaded) {
      return;
    }

    const response = await fetch(INDEX_URL, { headers: { "Accept": "application/json" } });
    if (!response.ok) {
      throw new Error(`Search index returned ${response.status}`);
    }

    const updates = await response.json();
    state.updates = updates.map(prepareUpdate);
    state.indexLoaded = true;
  };

  const runSearch = async (query, { updateUrl = true, focus = false } = {}) => {
    state.query = query.trim();
    input.value = state.query;
    clearButton.hidden = !state.query;

    if (updateUrl) {
      setUrlQuery(state.query);
    }

    if (!state.query) {
      count.textContent = "Type at least two characters to search all updates.";
      showDefaultView();
      if (!focus) {
        hideSearch();
      }
      return;
    }

    showSearch({ focus });

    const normalizedQuery = normalize(state.query);
    if (normalizedQuery.length < MIN_QUERY_LENGTH) {
      count.textContent = "Type at least two characters to search.";
      showResultsView();
      resultsRoot.innerHTML = "";
      return;
    }

    count.textContent = "Searching...";

    try {
      await loadIndex();
    } catch (error) {
      showResultsView();
      count.textContent = "Search is temporarily unavailable.";
      resultsRoot.innerHTML = `
        <article class="search-empty">
          <h2>Search index could not load.</h2>
          <p>The updates archive is still available below when search is cleared.</p>
        </article>
      `;
      return;
    }

    const terms = tokenize(state.query);
    const matches = state.updates
      .map((update) => ({ update, score: scoreUpdate(update, terms, normalizedQuery) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.update.date) - new Date(a.update.date));

    showResultsView();
    count.textContent = matches.length === 1
      ? "1 update found."
      : `${matches.length} updates found.`;

    if (!matches.length) {
      resultsRoot.innerHTML = `
        <article class="search-empty">
          <h2>No updates found.</h2>
          <p>Try a runner name, race name, year, or broader term like marathon, Back Cove, Beach to Beacon, or archive.</p>
        </article>
      `;
      return;
    }

    renderResults(matches, terms);
  };

  const debounce = (callback, delay = 120) => {
    let timeout;
    return (...args) => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => callback(...args), delay);
    };
  };

  toggle.addEventListener("click", () => {
    if (panel.hidden) {
      showSearch();
    } else if (!state.query) {
      hideSearch();
    } else {
      input.focus();
    }
  });

  input.addEventListener("input", debounce(() => runSearch(input.value)));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(input.value, { focus: true });
  });

  clearButton.addEventListener("click", () => {
    input.value = "";
    runSearch("");
    toggle.focus();
  });

  const params = new URLSearchParams(window.location.search);
  if (params.has("q")) {
    const initialQuery = params.get("q") || "";
    if (initialQuery) {
      runSearch(initialQuery, { updateUrl: false, focus: false });
    } else {
      showSearch({ focus: false });
    }
  }
})();
