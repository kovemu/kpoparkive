(() => {
  if (globalThis.__kpoparkiveFidelityCaptureLoaded) return;
  globalThis.__kpoparkiveFidelityCaptureLoaded = true;

  function norm(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function rounded(value) {
    return Math.round(Number(value || 0) * 10) / 10;
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: rounded(rect.x),
      y: rounded(rect.y + window.scrollY),
      width: rounded(rect.width),
      height: rounded(rect.height),
    };
  }

  function computed(element) {
    try {
      const style = getComputedStyle(element);
      return {
        display: style.display,
        position: style.position,
        float: style.float,
        width: style.width,
        maxWidth: style.maxWidth,
        minWidth: style.minWidth,
        height: style.height,
        overflowX: style.overflowX,
        tableLayout: style.tableLayout,
        borderCollapse: style.borderCollapse,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        textAlign: style.textAlign,
        verticalAlign: style.verticalAlign,
        backgroundColor: style.backgroundColor,
        color: style.color,
      };
    } catch {
      return {};
    }
  }

  function describe(element) {
    if (!(element instanceof Element)) return "";
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const classes = Array.from(element.classList || []).slice(0, 5).map((name) => `.${name}`).join("");
    return `${tag}${id}${classes}`.slice(0, 260);
  }

  function findRoot() {
    if (/kpoparkive\.vercel\.app$/i.test(location.hostname)) {
      const baseline = document.querySelector(".thetreeWikiBaseline.wiki-content, .thetreeWikiBaseline, .wiki-content");
      if (baseline) return { element: baseline, strategy: "thetree-baseline" };
    }

    try {
      if (typeof kpopFindPresentationRoot === "function") {
        const found = kpopFindPresentationRoot();
        if (found?.element) return { element: found.element, strategy: found.strategy || "namu-presentation-root" };
      }
    } catch {}

    const candidates = Array.from(document.querySelectorAll("article,main,[role='main'],section,div"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const tables = element.querySelectorAll("table").length;
        const headings = element.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
        const textLength = norm(element.textContent).length;
        const score = tables * 5000 + headings * 800 + Math.min(textLength, 20000);
        return { element, rect, tables, headings, textLength, score };
      })
      .filter((item) => item.rect.width > 400 && item.rect.height > 500 && item.tables > 0 && item.textLength > 500)
      .sort((a, b) => b.score - a.score || a.element.querySelectorAll("*").length - b.element.querySelectorAll("*").length);
    if (candidates[0]) return { element: candidates[0].element, strategy: "generic-content-score" };
    return { element: document.body, strategy: "body-fallback" };
  }

  function tokens(text) {
    const seen = new Set();
    const output = [];
    for (const token of norm(text).toLowerCase().split(/[\s·|/(),:;\[\]{}<>]+/)) {
      if (token.length < 2 || seen.has(token)) continue;
      seen.add(token);
      output.push(token.slice(0, 80));
      if (output.length >= 40) break;
    }
    return output;
  }

  function tableSummary(table, index) {
    const rows = Array.from(table.rows || []);
    const cols = rows.reduce((max, row) => Math.max(max, row.cells?.length || 0), 0);
    const wrap = table.closest(".wiki-table-wrap") || table.parentElement;
    const text = norm(table.textContent);
    return {
      index,
      selector: describe(table),
      rect: rectOf(table),
      rows: rows.length,
      cols,
      text: text.slice(0, 700),
      tokens: tokens(text),
      inlineStyle: String(table.getAttribute("style") || "").slice(0, 500),
      computed: computed(table),
      wrapper: wrap ? {
        selector: describe(wrap),
        rect: rectOf(wrap),
        inlineStyle: String(wrap.getAttribute("style") || "").slice(0, 500),
        computed: computed(wrap),
      } : null,
    };
  }

  function imageKey(value) {
    return norm(value)
      .replace(/^(?:파일|File):/i, "")
      .replace(/[?#].*$/, "")
      .toLowerCase();
  }

  function imageSummary(image, index) {
    const parent = image.parentElement;
    const alt = norm(image.getAttribute("alt") || image.getAttribute("title") || "");
    return {
      index,
      key: imageKey(alt),
      alt: alt.slice(0, 300),
      rect: rectOf(image),
      naturalWidth: Number(image.naturalWidth || 0),
      naturalHeight: Number(image.naturalHeight || 0),
      src: String(image.currentSrc || image.getAttribute("src") || image.getAttribute("data-src") || "").slice(0, 600),
      computed: computed(image),
      parent: parent ? { selector: describe(parent), rect: rectOf(parent), computed: computed(parent) } : null,
    };
  }

  function suspiciousText(text) {
    const markers = [
      "{{{#!wiki", "{{{#!if", "{{{#!style", "@국명@", "@배경색@",
      "class=\"", "tag=\"", "onclick=\"", "수동으로 입력해야 합니다.",
      "파일:대한민국 국기.svg", "#383b40;\"",
    ];
    return markers.filter((marker) => text.includes(marker));
  }

  function capture() {
    const rootInfo = findRoot();
    const root = rootInfo.element;
    const rootText = norm(root.textContent);
    const tables = Array.from(root.querySelectorAll("table"));
    const images = Array.from(root.querySelectorAll("img")).filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: norm(heading.textContent).slice(0, 300),
      rect: rectOf(heading),
    }));

    return {
      url: location.href,
      title: document.title,
      kind: /kpoparkive\.vercel\.app$/i.test(location.hostname) ? "thetree-baseline" : "namuwiki-live-original",
      capturedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      root: {
        strategy: rootInfo.strategy,
        selector: describe(root),
        rect: rectOf(root),
        computed: computed(root),
        textLength: rootText.length,
      },
      counts: { tables: tables.length, images: images.length, headings: headings.length },
      tables: tables.slice(0, 160).map(tableSummary),
      images: images.slice(0, 300).map(imageSummary),
      headings: headings.slice(0, 100),
      suspicious: suspiciousText(rootText),
      textSample: rootText.slice(0, 3000),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "kpoparkive-capture-live-fidelity") return;
    try { sendResponse({ ok: true, capture: capture() }); }
    catch (error) { sendResponse({ ok: false, error: error?.message || String(error) }); }
    return true;
  });
})();
