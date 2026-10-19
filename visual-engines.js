// Visual-aid engines. Each one receives finished transcript text through ingest(text)
// and calls onCard(card) whenever it has something to show.
//
//   FreeVisuals   – built-in library (library.js) + Wikipedia summaries. Free, no keys.
//   ClaudeVisuals – sends transcript to the local server, which asks Claude. PAID (optional).

(function () {
  function nowLabel() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Library charts use functions, which can't be sent to the pop-out window.
  // Turn them into plain labels + data first.
  function materializeChart(chart) {
    if (!chart || !chart.series) return chart;
    const labels = [];
    for (let x = chart.xMin; x <= chart.xMax + 1e-9; x += chart.step) labels.push(+x.toFixed(4));
    return {
      type: chart.type || "line", title: chart.title, xLabel: chart.xLabel, yLabel: chart.yLabel, fill: chart.fill,
      labels: labels.map(String),
      datasets: chart.series.map((s) => ({
        label: s.label,
        data: labels.map((x) => { const y = s.fn(x); return Number.isFinite(y) ? +y.toFixed(4) : null; }),
      })),
    };
  }

  function areasForSubject(subject) {
    const s = " " + subject.toLowerCase() + " ";
    return Object.entries(window.SUBJECT_AREAS || {})
      .filter(([, words]) => words.some((w) => s.includes(w)))
      .map(([area]) => area);
  }

  // ---------------- Wikipedia (free, no key) ----------------
  async function wikiCard(term, wikiLang, label) {
    const base = `https://${wikiLang}.wikipedia.org`;
    const search = await fetch(
      `${base}/w/api.php?action=query&list=search&srlimit=1&format=json&origin=*&srsearch=${encodeURIComponent(term)}`
    ).then((r) => r.json());
    const title = search?.query?.search?.[0]?.title;
    if (!title) return null;
    const page = await fetch(`${base}/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then((r) => r.json());
    if (!page || page.type === "disambiguation" || !page.extract) return null;
    return {
      id: "wiki:" + title,
      topic: page.title,
      summary: page.extract,
      image: page.thumbnail ? { src: page.thumbnail.source, caption: page.title } : null,
      link: page.content_urls?.desktop?.page,
      source: label || "Wikipedia",
      time: nowLabel(),
    };
  }

  class FreeVisuals {
    constructor({ subject, topic, keyTerms, language, onCard, onStatus }) {
      this.subject = subject;
      this.topic = topic;
      this.keyTerms = keyTerms;
      this.wikiLang = (language || "en").split("-")[0];
      this.onCard = onCard;
      this.onStatus = onStatus || (() => {});
      this.shown = new Set();
      this.tail = ""; // end of the previous text, so phrases split across segments still match

      const areas = areasForSubject(subject + " " + topic);
      // If the subject is recognised, only use topics from that area (avoids false matches
      // like "current" in a history class). Otherwise use the whole library.
      this.topics = (window.TOPIC_LIBRARY || []).filter((t) => !areas.length || areas.includes(t.area));
      this.matchers = this.topics.map((t) => ({
        topic: t,
        re: new RegExp("\\b(" + t.keywords.map(escapeRegex).join("|") + ")\\b", "i"),
      }));
      this.termMatchers = keyTerms.map((term) => ({ term, re: new RegExp("\\b" + escapeRegex(term) + "\\b", "i") }));
    }

    start() {
      // Overview card for the subject itself.
      const lookup = this.topic ? this.topic : this.subject;
      this.lookupWiki(lookup, "Overview · Wikipedia");
    }

    ingest(text) {
      const window_ = (this.tail + " " + text).toLowerCase();
      this.tail = text.slice(-60);
      for (const { topic, re } of this.matchers) {
        if (!this.shown.has(topic.id) && re.test(window_)) this.showTopic(topic);
      }
      for (const { term, re } of this.termMatchers) {
        if (!this.shown.has("term:" + term) && re.test(window_)) {
          this.shown.add("term:" + term);
          if (!this.showFromLibrary(term)) this.lookupWiki(term);
        }
      }
    }

    // Manual "look up a term" box.
    lookup(term) {
      if (!this.showFromLibrary(term, true)) this.lookupWiki(term, "Wikipedia", true);
    }

    showFromLibrary(term, force) {
      const t = term.toLowerCase();
      const match = (window.TOPIC_LIBRARY || []).find(
        (x) => x.title.toLowerCase().includes(t) || x.keywords.some((k) => k === t)
      );
      if (!match) return false;
      if (force || !this.shown.has(match.id)) this.showTopic(match, force);
      return true;
    }

    showTopic(topic, force) {
      if (this.shown.has(topic.id) && !force) return;
      this.shown.add(topic.id);
      this.onCard({
        id: topic.id,
        topic: topic.title,
        summary: topic.summary,
        keyPoints: topic.keyPoints,
        formula: topic.formula || "",
        examples: topic.examples || [],
        chart: materializeChart(topic.chart),
        diagram: topic.diagram || "",
        source: "Built-in library",
        time: nowLabel(),
      });
    }

    async lookupWiki(term, label, force) {
      const key = "wikiq:" + term.toLowerCase();
      if (this.shown.has(key) && !force) return;
      this.shown.add(key);
      try {
        const card = await wikiCard(term, this.wikiLang, label);
        if (card && (force || !this.shown.has(card.id))) {
          this.shown.add(card.id);
          this.onCard(card);
        } else if (!card && force) {
          this.onStatus(`No Wikipedia article found for "${term}".`);
        }
      } catch {
        this.onStatus("Wikipedia lookup failed (are you online?).");
      }
    }

    flush() {}
  }

  // ---------------- Claude (paid, optional) ----------------
  class ClaudeVisuals {
    constructor({ subject, topic, keyTerms, onCard, onStatus }) {
      this.subject = subject;
      this.topic = topic;
      this.keyTerms = keyTerms;
      this.onCard = onCard;
      this.onStatus = onStatus || (() => {});
      this.pending = "";   // transcript not yet sent to Claude
      this.context = "";   // everything sent so far
      this.previousTopics = [];
      this.inFlight = false;
      this.timer = setInterval(() => this.maybeSend(true), 45000);
      this.free = new FreeVisuals({ subject, topic, keyTerms, onCard, onStatus }); // for manual lookups
    }

    start() {}

    ingest(text) {
      this.pending += " " + text;
      this.maybeSend(false);
    }

    lookup(term) {
      this.free.lookup(term);
    }

    flush() {
      this.maybeSend(true);
    }

    async maybeSend(force) {
      const words = this.pending.trim().split(/\s+/).filter(Boolean).length;
      if (this.inFlight || words === 0 || (!force && words < 70)) return;
      const newText = this.pending.trim();
      this.pending = "";
      this.inFlight = true;
      this.onStatus("Claude is preparing visual aids…");
      try {
        const r = await fetch("/api/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: this.subject, topic: this.topic, keyTerms: this.keyTerms,
            newText, context: this.context.slice(-3000), previousTopics: this.previousTopics.slice(-30),
          }),
        });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || "Request failed");
        for (const c of body.cards || []) {
          this.previousTopics.push(c.topic);
          this.onCard({ ...c, id: "claude:" + c.topic, source: "Claude", time: nowLabel() });
        }
        this.context += " " + newText;
        this.onStatus("");
      } catch (err) {
        this.pending = newText + " " + this.pending; // try again with the next batch
        this.onStatus("Claude: " + err.message);
      } finally {
        this.inFlight = false;
      }
    }

    stop() {
      clearInterval(this.timer);
    }
  }

  window.FreeVisuals = FreeVisuals;
  window.ClaudeVisuals = ClaudeVisuals;
})();
