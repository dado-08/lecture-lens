// Transcription engines. Both expose start() / stop() and call:
//   onPartial(text) – words still being recognised (may change)
//   onFinal(text)   – a finished segment
//   onStatus(text, level) – "live" | "idle" | "error" messages for the status bar
//
//   BrowserTranscriber – built-in Web Speech API (Chrome / Edge / Safari). FREE.
//   ScribeTranscriber  – ElevenLabs Scribe v2 Realtime via the local server. PAID (optional).

(function () {
  // ---------------- Free: browser speech recognition ----------------
  class BrowserTranscriber {
    static isSupported() {
      return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    static isSafari() {
      return /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
    }

    constructor({ language, onPartial, onFinal, onStatus }) {
      this.language = language;
      this.onPartial = onPartial;
      this.onFinal = onFinal;
      this.onStatus = onStatus;
      this.running = false;
      this.safari = BrowserTranscriber.isSafari();
    }

    // Words heard but not yet marked final. Safari often never finalises them and
    // throws them away when it stops, so we keep them and commit them ourselves.
    flushPending() {
      clearTimeout(this.pauseTimer);
      const text = (this.pending || "").trim();
      this.pending = "";
      this.onPartial("");
      if (text) this.onFinal(text);
    }

    start() {
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new Recognition();
      rec.lang = this.language;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let emitted = new Set(); // result indexes already committed in this recognition session
      this.pending = "";

      rec.onstart = () => { emitted = new Set(); };
      rec.onresult = (event) => {
        let interim = "";
        // Scan every result: Safari doesn't always report resultIndex correctly.
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            if (!emitted.has(i)) {
              emitted.add(i);
              this.pending = "";
              this.onFinal(result[0].transcript.trim());
            }
          } else {
            interim += result[0].transcript;
          }
        }
        this.pending = interim;
        this.onPartial(interim.trim());

        // Safari: after a 2-second pause, lock in what was heard (stop → onend commits it → restart).
        if (this.safari) {
          clearTimeout(this.pauseTimer);
          if (interim.trim()) this.pauseTimer = setTimeout(() => { try { rec.stop(); } catch { /* already stopping */ } }, 2000);
        }
      };
      rec.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return; // harmless, it restarts
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.running = false;
          this.blocked = true;
          this.onStatus("Microphone permission was blocked. Allow it in the address bar and try again.", "error");
        } else if (event.error === "network") {
          this.onStatus("Browser speech recognition needs an internet connection.", "error");
        } else {
          this.onStatus("Speech recognition error: " + event.error, "error");
        }
      };
      // Browsers stop listening after a pause; keep any unfinished words, then restart right away.
      rec.onend = () => {
        this.flushPending();
        if (this.running) {
          try {
            rec.start();
          } catch {
            setTimeout(() => { if (this.running) try { rec.start(); } catch { /* gave up this cycle */ } }, 250);
          }
        } else if (!this.blocked) {
          this.onStatus("Paused", "idle");
        }
      };

      this.rec = rec;
      this.running = true;
      this.blocked = false;
      rec.start();
      this.onStatus("Listening (free browser engine)", "live");
    }

    stop() {
      this.running = false;
      this.rec?.stop(); // onend commits any unfinished words
    }
  }

  // ---------------- Paid: ElevenLabs Scribe v2 Realtime ----------------
  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  class ScribeTranscriber {
    constructor({ language, subject, topic, keyTerms, onPartial, onFinal, onStatus }) {
      this.languageCode = (language || "").split("-")[0];
      this.subject = subject;
      this.topic = topic;
      this.keyTerms = keyTerms;
      this.onPartial = onPartial;
      this.onFinal = onFinal;
      this.onStatus = onStatus;
      this.running = false;
      this.useKeyterms = keyTerms.length > 0;
    }

    async start() {
      this.running = true;
      this.onStatus("Connecting to Scribe…", "idle");
      try {
        if (!this.stream) {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        }
        await this.connect();
      } catch (err) {
        this.running = false;
        this.onStatus("Could not start Scribe: " + err.message, "error");
      }
    }

    async connect() {
      const r = await fetch("/api/scribe-token");
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "token request failed");

      const params = new URLSearchParams({
        model_id: "scribe_v2_realtime",
        token: body.token,
        audio_format: "pcm_16000",
        commit_strategy: "vad",
      });
      if (this.languageCode) params.set("language_code", this.languageCode);
      // Bias recognition toward the course's vocabulary (helps a lot with accents + jargon).
      if (this.useKeyterms) this.keyTerms.slice(0, 50).forEach((t) => params.append("keyterms", t));

      const ws = new WebSocket("wss://api.elevenlabs.io/v1/speech-to-text/realtime?" + params);
      this.ws = ws;
      this.sentFirstChunk = false;
      this.sessionStarted = false;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.message_type) {
          case "session_started":
            this.sessionStarted = true;
            this.onStatus("Listening (ElevenLabs Scribe)", "live");
            break;
          case "partial_transcript":
            this.onPartial(msg.text || "");
            break;
          case "committed_transcript":
            if (msg.text && msg.text.trim()) this.onFinal(msg.text.trim());
            this.onPartial("");
            break;
          case "warning":
            console.warn("Scribe warning:", msg.warning);
            break;
          default:
            if (msg.error) {
              // If the keyterm list was rejected before the session started, retry without it.
              if (!this.sessionStarted && this.useKeyterms) {
                console.warn("Scribe rejected the request, retrying without keyterms:", msg.error);
                this.useKeyterms = false;
                ws.onclose = null;
                ws.close();
                this.stopAudio();
                this.connect().catch((e) => this.onStatus("Scribe: " + e.message, "error"));
                return;
              }
              this.onStatus(`Scribe ${msg.message_type}: ${msg.error}`, "error");
            }
        }
      };
      ws.onclose = () => {
        this.stopAudio();
        if (this.running) {
          // Sessions have a time limit and tokens are single-use: reconnect with a new token.
          this.onStatus("Reconnecting to Scribe…", "idle");
          setTimeout(() => this.running && this.connect().catch((e) => this.onStatus("Scribe: " + e.message, "error")), 500);
        } else {
          this.onStatus("Paused", "idle");
        }
      };
      ws.onopen = () => this.startAudio();
    }

    async startAudio() {
      // 16 kHz context so the browser does the resampling for us.
      this.ctx = new AudioContext({ sampleRate: 16000 });
      await this.ctx.audioWorklet.addModule("pcm-worklet.js");
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
      this.node.port.onmessage = (event) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const msg = {
          message_type: "input_audio_chunk",
          audio_base_64: toBase64(event.data),
          commit: false,
          sample_rate: 16000,
        };
        if (!this.sentFirstChunk) {
          // Context for the first chunk only: tells Scribe what the lecture is about.
          msg.previous_text = [`Lecture on ${this.subject}.`, this.topic && `Topic: ${this.topic}.`,
            this.keyTerms.length && `Terms: ${this.keyTerms.join(", ")}.`].filter(Boolean).join(" ");
          this.sentFirstChunk = true;
        }
        this.ws.send(JSON.stringify(msg));
      };
      source.connect(this.node);
    }

    stopAudio() {
      this.node?.disconnect();
      this.ctx?.close().catch(() => {});
      this.node = null;
      this.ctx = null;
    }

    stop() {
      this.running = false;
      this.ws?.close();
      this.stopAudio();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.onPartial("");
    }
  }

  window.BrowserTranscriber = BrowserTranscriber;
  window.ScribeTranscriber = ScribeTranscriber;
})();
