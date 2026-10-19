// Draws a visual-aid "card" (summary, key points, formula, graph, diagram, examples, image).
// Shared by the main page and the pop-out visuals page.
// Chart.js, KaTeX and Mermaid are loaded from a CDN; if one is unavailable (offline),
// that part of the card falls back to plain text.

(function () {
  let mermaidReady = false;
  let diagramCounter = 0;

  function initMermaid() {
    if (mermaidReady || !window.mermaid) return;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    mermaidReady = true;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const SERIES_COLORS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"];

  // Library charts give functions (series[].fn); Claude charts give data (labels + datasets).
  function chartConfig(chart) {
    let labels = chart.labels || [];
    let datasets = chart.datasets || [];
    if (chart.series) {
      labels = [];
      for (let x = chart.xMin; x <= chart.xMax + 1e-9; x += chart.step) labels.push(+x.toFixed(4));
      datasets = chart.series.map((s) => ({
        label: s.label,
        data: labels.map((x) => {
          const y = s.fn(x);
          return Number.isFinite(y) ? +y.toFixed(4) : null;
        }),
      }));
    }
    const type = chart.type === "bar" ? "bar" : "line";
    const grid = cssVar("--chart-grid");
    const text = cssVar("--text-muted");
    return {
      type,
      data: {
        labels,
        datasets: datasets.map((d, i) => {
          const color = cssVar(SERIES_COLORS[i % SERIES_COLORS.length]);
          return {
            label: d.label,
            data: d.data,
            borderColor: color,
            backgroundColor: type === "bar" ? color : chart.fill ? color + "33" : color,
            fill: Boolean(chart.fill),
            pointRadius: chart.type === "scatter" ? 4 : 0,
            showLine: chart.type !== "scatter",
            borderWidth: 2,
            tension: 0.25,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: datasets.length > 1, labels: { color: text } },
          title: { display: Boolean(chart.title), text: chart.title, color: text },
        },
        scales: {
          x: { title: { display: Boolean(chart.xLabel), text: chart.xLabel, color: text },
               ticks: { color: text, maxTicksLimit: 9 }, grid: { color: grid } },
          y: { title: { display: Boolean(chart.yLabel), text: chart.yLabel, color: text },
               ticks: { color: text }, grid: { color: grid } },
        },
      },
    };
  }

  function addChart(card, chart) {
    if (!chart) return;
    if (chart.include === false) return;
    if (!chart.series && !(chart.datasets && chart.datasets.length)) return;
    const wrap = el("div", "card-chart");
    card.appendChild(wrap);
    if (!window.Chart) {
      wrap.appendChild(el("p", "muted", "(Graph unavailable offline: " + (chart.title || "chart") + ")"));
      return;
    }
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    try {
      new window.Chart(canvas, chartConfig(chart));
    } catch (err) {
      wrap.replaceChildren(el("p", "muted", "(Could not draw graph)"));
    }
  }

  function addFormula(card, latex) {
    if (!latex) return;
    const box = el("div", "card-formula");
    if (window.katex) {
      // trust:false + throwOnError:false keeps untrusted input safe and never crashes the page
      box.innerHTML = window.katex.renderToString(latex, { displayMode: true, throwOnError: false, trust: false });
    } else {
      box.textContent = latex;
    }
    card.appendChild(box);
  }

  function addDiagram(card, source) {
    if (!source) return;
    const box = el("div", "card-diagram");
    card.appendChild(box);
    initMermaid();
    if (!window.mermaid) {
      box.appendChild(el("pre", "muted", source));
      return;
    }
    const id = "diagram-" + Date.now() + "-" + diagramCounter++;
    window.mermaid
      .render(id, source)
      .then(({ svg }) => { box.innerHTML = svg; }) // Mermaid output is sanitised (securityLevel: strict)
      .catch(() => {
        document.getElementById("d" + id)?.remove(); // Mermaid leaves an error node behind
        box.remove();
      });
  }

  window.renderCard = function renderCard(data) {
    const card = el("article", "card");
    card.dataset.cardId = data.id || "";

    const head = el("header", "card-head");
    head.appendChild(el("h3", null, data.topic || data.title || "Topic"));
    const meta = el("span", "card-meta", [data.source, data.time].filter(Boolean).join(" · "));
    head.appendChild(meta);
    card.appendChild(head);

    if (data.image && data.image.src) {
      const fig = el("figure", "card-image");
      const img = document.createElement("img");
      img.src = data.image.src;
      img.alt = data.image.caption || data.topic || "";
      img.loading = "lazy";
      fig.appendChild(img);
      card.appendChild(fig);
    }

    if (data.summary) card.appendChild(el("p", "card-summary", data.summary));

    if (data.keyPoints && data.keyPoints.length) {
      const ul = el("ul", "card-points");
      data.keyPoints.forEach((p) => ul.appendChild(el("li", null, p)));
      card.appendChild(ul);
    }

    addFormula(card, data.formula);
    addChart(card, data.chart);
    addDiagram(card, data.diagram);

    (data.examples || []).forEach((ex) => {
      const box = el("div", "card-example");
      box.appendChild(el("div", "card-example-title", "Example: " + (ex.title || "")));
      box.appendChild(el("pre", null, ex.body || ""));
      card.appendChild(box);
    });

    if (data.link) {
      const a = el("a", "card-link", "Read more →");
      a.href = data.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      card.appendChild(a);
    }
    return card;
  };
})();
