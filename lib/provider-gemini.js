// Gemini Live API provider — native-audio bidirectional voice over a
// WebSocket, implementing the same interface as OpenAIRealtimeProvider so it
// drops into sidepanel.js unchanged.
//
// Transport:  wss://generativelanguage.googleapis.com/ws/.../BidiGenerateContent?key=API_KEY
// Model:      a native-audio Live model (Gemini 2.5 Flash native audio) — this
//             produces the spoken audio (TTS) natively and transcribes the mic.
// Mic in:     16 kHz PCM16 chunks as realtimeInput.mediaChunks
// Audio out:  24 kHz PCM16 from serverContent.modelTurn parts, queued for playback
// Tools:      functionDeclarations in setup; answered with toolResponse

// ---------- audio helpers ----------

function b64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function downsampleTo16k(input, inRate) {
  if (inRate === 16000) return input;
  const ratio = inRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let j = start; j < end; j++) { sum += input[j]; n++; }
    out[i] = n ? sum / n : input[start] || 0;
  }
  return out;
}

function floatToPCM16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class GeminiLiveProvider {
  constructor(opts) {
    this.opts = opts;
    this.cb = opts.callbacks || {};
    this.ws = null;
    this.micStream = null;
    this.inCtx = null;
    this.outCtx = null;
    this.processor = null;
    this.muted = false;
    this.setupDone = false;
    this.sources = new Set();   // scheduled playback nodes, for barge-in flush
    this.nextStartTime = 0;
    this.callNames = new Map();  // functionCall id -> name (needed for toolResponse)
    this.userBuf = '';           // accumulate streamed input transcription
  }

  async connect() {
    const { apiKey, model } = this.opts;
    if (!apiKey) throw new Error('No Gemini API key set. Add one on the Trish Settings page.');

    this.cb.onStatus?.('Requesting microphone…');
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Mic capture graph: source -> processor -> silent sink (so it runs without
    // echoing the mic to the speakers).
    this.inCtx = new AudioContext();
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    const source = this.inCtx.createMediaStreamSource(this.micStream);
    const processor = this.inCtx.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (e) => {
      if (!this.setupDone || this.muted || this.ws?.readyState !== WebSocket.OPEN) return;
      const pcm = floatToPCM16(downsampleTo16k(e.inputBuffer.getChannelData(0), this.inCtx.sampleRate));
      this.send({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: b64FromBytes(new Uint8Array(pcm.buffer)) }]
        }
      });
    };
    const sink = this.inCtx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(this.inCtx.destination);

    this.cb.onStatus?.('Connecting to Gemini…');
    await new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Gemini Live.')), 15000);
      this._readyTimer = timer;

      const ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(apiKey)}`);
      this.ws = ws;
      ws.onopen = () => this.send({ setup: this.#setupMsg(model) });
      ws.onmessage = (e) => this.#onMessage(e);
      ws.onerror = () => {
        if (!this.setupDone) reject(new Error('Gemini WebSocket error (check API key and network).'));
      };
      ws.onclose = () => {
        if (!this.setupDone) reject(new Error('Gemini closed the connection before setup — check the API key and model name on the Settings page.'));
        else this.cb.onClosed?.('closed');
      };
    });
  }

  #setupMsg(model) {
    const tools = this.#geminiTools();
    const setup = {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voice || 'Puck' } }
        }
      },
      systemInstruction: { parts: [{ text: this.opts.instructions || '' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    };
    if (tools) setup.tools = tools;
    return setup;
  }

  // Convert OpenAI-style tool defs to Gemini functionDeclarations. Their
  // `parameters` are already a compatible JSON-schema subset; omit it when the
  // tool takes no arguments (Gemini rejects empty object schemas).
  #geminiTools() {
    const fns = (this.opts.tools || []).map((t) => {
      const decl = { name: t.name, description: t.description };
      const p = t.parameters;
      if (p?.properties && Object.keys(p.properties).length) decl.parameters = p;
      return decl;
    });
    return fns.length ? [{ functionDeclarations: fns }] : undefined;
  }

  async #onMessage(event) {
    let text;
    try {
      text = event.data instanceof Blob ? await event.data.text() : event.data;
    } catch { return; }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.setupComplete) {
      this.setupDone = true;
      clearTimeout(this._readyTimer);
      this._resolveReady?.();
      this.cb.onStatus?.('Connected — listening');
      // Greet so a blind user knows the session is live (injected as text, so
      // it does not appear as a user transcript).
      this.send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: 'Greet me in one short sentence and say you are ready.' }] }],
          turnComplete: true
        }
      });
      return;
    }

    if (msg.serverContent) {
      const sc = msg.serverContent;
      if (sc.interrupted) this.#flushAudio();
      if (sc.inputTranscription?.text) this.userBuf += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) {
        this.#flushUser();
        this.cb.onAssistantDelta?.(sc.outputTranscription.text);
      }
      for (const part of sc.modelTurn?.parts || []) {
        const d = part.inlineData;
        if (d && (d.mimeType || '').startsWith('audio/pcm')) this.#playAudio(d.data);
      }
      if (sc.turnComplete) {
        this.#flushUser();
        this.cb.onAssistantDone?.();
      }
      return;
    }

    if (msg.toolCall) {
      this.#flushUser();
      for (const fc of msg.toolCall.functionCalls || []) {
        this.callNames.set(fc.id, fc.name);
        this.cb.onToolCall?.(fc.name, fc.args || {}, fc.id);
      }
      return;
    }

    if (msg.goAway) {
      this.cb.onError?.(new Error('Gemini is ending the session (server goAway).'));
    }
  }

  #flushUser() {
    if (this.userBuf.trim()) this.cb.onUserTranscript?.(this.userBuf.trim());
    this.userBuf = '';
  }

  #playAudio(b64) {
    const bytes = bytesFromB64(b64);
    const usable = bytes.length - (bytes.length % 2);
    const pcm = new Int16Array(bytes.buffer, 0, usable / 2);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000;
    if (!f32.length) return;
    const buf = this.outCtx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outCtx.destination);
    const start = Math.max(this.outCtx.currentTime, this.nextStartTime);
    src.start(start);
    this.nextStartTime = start + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  #flushAudio() {
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    this.nextStartTime = 0;
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendToolResult(callId, outputString) {
    const name = this.callNames.get(callId);
    this.callNames.delete(callId);
    let response;
    try { response = JSON.parse(outputString); } catch { response = { result: outputString }; }
    this.send({ toolResponse: { functionResponses: [{ id: callId, name, response }] } });
  }

  sendImage(dataUrl) {
    const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl || '');
    if (!m) return;
    this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ inlineData: { mimeType: m[1], data: m[2] } }] }],
        turnComplete: false
      }
    });
  }

  sendSystemNote(text) {
    this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: '[context] ' + text }] }],
        turnComplete: false
      }
    });
  }

  requestResponse() {
    this.send({ clientContent: { turnComplete: true } });
  }

  setMicEnabled(enabled) {
    this.muted = !enabled;
  }

  disconnect() {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.micStream?.getTracks().forEach((t) => t.stop());
    if (this.processor) this.processor.onaudioprocess = null;
    this.#flushAudio();
    try { this.inCtx?.close(); } catch { /* noop */ }
    try { this.outCtx?.close(); } catch { /* noop */ }
    this.ws = null;
    this.setupDone = false;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && this.setupDone;
  }
}
