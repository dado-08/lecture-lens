// Main page logic: setup screen → live session (transcript + visual aids).

(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    subject: "", topic: "", keyTerms: [], language: "en-US",
    transcriber: null, visuals: null,
    segments: [], cards: [],
    listening: false, popup: null,
  };

  // ---------- Which engines are available? ----------
  async function detectPaidFeatures() {
    if (location.protocol === "file:") return { scribe: false, claude: false }; // opened directly = free mode
    try {
      const r = await fetch("/api/config");
      return r.ok ? await r.json() : { scribe: false, claude: false };
    } catch {
      return { scribe: false, claude: false };
    }
  }

  function enableOption(name, value) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    input.disabled = false;
    const tag = input.parentElement.querySelector(".tag");
    if (tag) tag.textContent = "paid · on";
  }

  async function initSetup() {
    try {
      const saved = JSON.parse(localStorage.getItem("lecture-lens-setup") || "{}");
      if (saved.subject) $("subject").value = saved.subject;
      if (saved.keyTerms) $("keyterms").value = saved.keyTerms;
      if (saved.language) $("language").value = saved.language;
    } catch { /* storage unavailable */ }

    const paid = await detectPaidFeatures();
    if (paid.scribe) enableOption("stt", "scribe");
    if (paid.claude) enableOption("vis", "claude");

    if (!BrowserTranscriber.isSupported()) {
      const warn = $("setup-warning");
      warn.hidden = false;
      warn.textContent = paid.scribe
        ? "This browser has no built-in speech recognition. Use Scribe, or open this page in Chrome or Edge."
        : "This browser has no built-in speech recognition. Please open this page in Google Chrome or Microsoft Edge.";
      document.querySelector('input[name="stt"][value="browser"]').disabled = true;
      if (paid.scribe) document.querySelector('input[name="stt"][value="scribe"]').checked = true;
    } else if (BrowserTranscriber.isSafari()) {
      const warn = $("setup-warning");
      warn.hidden = false;
      warn.textContent = "Tip: Safari's speech recognition often stops and skips words. " +
        "For full sentences, open this page in Google Chrome or Microsoft Edge.";
    }
  }

  // ---------- Status ----------
  function setStatus(text, level) {
    $("status-text").textContent = text;
    $("status-dot").className = "dot " + (level || "");
    if (level === "live") {
      state.listening = true;
      $("mic-btn").textContent = "Pause";
    } else if (level === "idle" && text === "Paused") {
      state.listening = false;
      $("mic-btn").textContent = "Resume";
    } else if (level === "error") {
      state.listening = false;
      $("mic-btn").textContent = "Resume";
    }
  }

  // ---------- Transcript ----------
  function isNearBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }

  function addSegment(text) {
    if (!text) return;
    const box = $("transcript");
    const stick = isNearBottom(box);
    $("transcript-empty")?.remove();
    const time = new Date();
    state.segments.push({ time, text });

    const p = document.createElement("p");
    const t = document.createElement("time");
    t.textContent = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.append(t, document.createTextNode(" " + text));
    box.appendChild(p);
    if (stick) box.scrollTop = box.scrollHeight;

    state.visuals.ingest(text);
  }

  function showPartial(text) {
    $("partial").textContent = text;
  }

  // ---------- Visual aids ----------
  function addCard(card) {
    state.cards.push(card);
    $("cards").prepend(renderCard(card));
    $("card-count").textContent = state.cards.length;
    if (state.popup && !state.popup.closed) state.popup.postMessage({ type: "card", card }, "*");
  }

  function setVisualStatus(text) {
    $("visual-status").textContent = text;
  }

  // ---------- Pop-out visuals page ----------
  window.addEventListener("message", (event) => {
    if (!state.popup || event.source !== state.popup) return;
    if (event.data && event.data.type === "hello") {
      state.popup.postMessage({ type: "init", subject: state.subject, cards: state.cards }, "*");
    }
  });

  // ---------- Session control ----------
  function startSession(event) {
    event.preventDefault();
    state.subject = $("subject").value.trim();
    state.topic = $("topic").value.trim();
    state.keyTerms = $("keyterms").value.split(",").map((s) => s.trim()).filter(Boolean);
    state.language = $("language").value.split("#")[0]; // "en-US#chinese" → "en-US" (no special browser model)
    const stt = document.querySelector('input[name="stt"]:checked')?.value;
    const vis = document.querySelector('input[name="vis"]:checked')?.value;
    if (!state.subject || !stt) return;

    try {
      localStorage.setItem("lecture-lens-setup", JSON.stringify({
        subject: state.subject, keyTerms: $("keyterms").value, language: $("language").value,
      }));
    } catch { /* storage unavailable */ }

    state.segments = [];
    state.cards = [];
    $("transcript").replaceChildren();
    const empty = document.createElement("p");
    empty.id = "transcript-empty";
    empty.className = "muted";
    empty.textContent = "Waiting for the teacher to speak…";
    $("transcript").appendChild(empty);
    $("cards").replaceChildren();
    $("card-count").textContent = "0";
    $("session-subject").textContent = state.subject + (state.topic ? " — " + state.topic : "");
    document.title = state.subject + " · Lecture Lens";

    const common = { subject: state.subject, topic: state.topic, keyTerms: state.keyTerms, language: state.language };
    const Visuals = vis === "claude" ? ClaudeVisuals : FreeVisuals;
    state.visuals = new Visuals({ ...common, onCard: addCard, onStatus: setVisualStatus });

    const Transcriber = stt === "scribe" ? ScribeTranscriber : BrowserTranscriber;
    state.transcriber = new Transcriber({ ...common, onPartial: showPartial, onFinal: addSegment, onStatus: setStatus });

    $("setup").hidden = true;
    $("session").hidden = false;
    state.visuals.start();
    state.transcriber.start();
  }

  function toggleMic() {
    if (!state.transcriber) return;
    if (state.listening) {
      state.transcriber.stop();
      state.visuals.flush();
      setStatus("Paused", "idle");
    } else {
      state.transcriber.start();
    }
  }

  function endSession() {
    state.transcriber?.stop();
    state.visuals?.stop?.();
    state.transcriber = null;
    state.listening = false;
    $("session").hidden = true;
    $("setup").hidden = false;
    document.title = "Lecture Lens";
  }

  function downloadTranscript() {
    const header = `${state.subject}${state.topic ? " — " + state.topic : ""}\n${new Date().toLocaleString()}\n\n`;
    const body = state.segments
      .map((s) => `[${s.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}] ${s.text}`)
      .join("\n");
    const blob = new Blob([header + body + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.subject || "lecture").replace(/[^\w\- ]+/g, "").trim() + " transcript.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function openPopout() {
    state.popup = window.open("visuals.html", "lecture-lens-visuals", "width=720,height=900");
    if (!state.popup) setVisualStatus("Pop-up was blocked. Allow pop-ups for this page and try again.");
  }

  // ---------- Wire up ----------
  $("setup-form").addEventListener("submit", startSession);
  $("mic-btn").addEventListener("click", toggleMic);
  $("new-btn").addEventListener("click", endSession);
  $("download-btn").addEventListener("click", downloadTranscript);
  $("popout-btn").addEventListener("click", openPopout);
  $("lookup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const term = $("lookup-input").value.trim();
    if (term && state.visuals) state.visuals.lookup(term);
    $("lookup-input").value = "";
  });
  document.querySelectorAll(".tabs button").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      $("panels").className = "panels show-" + btn.dataset.tab;
    })
  );

  initSetup();
})();
