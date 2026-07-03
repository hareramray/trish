// OpenAI Realtime API provider: one WebRTC connection carries mic audio up,
// synthesized speech down, and JSON events (including tool calls) over a
// data channel. Docs: https://platform.openai.com/docs/guides/realtime
export class OpenAIRealtimeProvider {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model      e.g. "gpt-realtime"
   * @param {string} opts.voice      e.g. "marin", "cedar", "alloy"
   * @param {string} opts.instructions  system prompt
   * @param {Array}  opts.tools      Realtime-format tool definitions
   * @param {object} opts.callbacks  { onStatus, onUserTranscript,
   *   onAssistantDelta, onAssistantDone, onToolCall, onError, onClosed }
   */
  constructor(opts) {
    this.opts = opts;
    this.cb = opts.callbacks;
    this.pc = null;
    this.dc = null;
    this.micStream = null;
    this.handledCalls = new Set();
  }

  async connect(audioElement) {
    const { apiKey, model } = this.opts;
    this.cb.onStatus('Requesting microphone…');
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    this.cb.onStatus('Connecting to OpenAI…');
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.ontrack = (e) => { audioElement.srcObject = e.streams[0]; };
    pc.addTrack(this.micStream.getTracks()[0], this.micStream);
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.cb.onClosed?.(pc.connectionState);
      }
    };

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (e) => this.#handleEvent(JSON.parse(e.data));

    const opened = new Promise((resolve, reject) => {
      dc.onopen = resolve;
      dc.onerror = (e) => reject(new Error('Data channel error: ' + e.message));
      setTimeout(() => reject(new Error('Timed out connecting to OpenAI Realtime.')), 15000);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const resp = await fetch(
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
      {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/sdp'
        }
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`OpenAI connection failed (HTTP ${resp.status}). ${body.slice(0, 300)}`);
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
    await opened;

    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.opts.instructions,
        tools: this.opts.tools,
        tool_choice: 'auto',
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: { type: 'semantic_vad' }
          },
          output: { voice: this.opts.voice }
        }
      }
    });

    // Greet so a blind user knows the session is live without any visual cue.
    this.send({
      type: 'response.create',
      response: {
        instructions:
          'Greet the user in one short sentence: say you are ready and they can ' +
          'ask about this page or tell you what to do.'
      }
    });
    this.cb.onStatus('Connected — listening');
  }

  send(obj) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }

  sendToolResult(callId, outputString) {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: outputString }
    });
    this.send({ type: 'response.create' });
  }

  // Attach a screenshot so the model can see the page (gpt-realtime accepts
  // image input). Caller follows up with a tool result + response.create.
  sendImage(dataUrl) {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: dataUrl }]
      }
    });
  }

  // Ask the model to produce a spoken turn now (e.g. right after a browser
  // dialog opened, so the user hears about it without having to prompt).
  requestResponse() {
    this.send({ type: 'response.create' });
  }

  // Add background context (e.g. a page alert) without forcing a spoken reply.
  sendSystemNote(text) {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text }]
      }
    });
  }

  setMicEnabled(enabled) {
    this.micStream?.getTracks().forEach(t => { t.enabled = enabled; });
  }

  disconnect() {
    this.micStream?.getTracks().forEach(t => t.stop());
    this.dc?.close();
    this.pc?.close();
    this.pc = this.dc = this.micStream = null;
  }

  get connected() {
    return this.dc?.readyState === 'open';
  }

  #handleEvent(ev) {
    switch (ev.type) {
      // GA and beta event names for assistant speech transcript
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.cb.onAssistantDelta(ev.delta);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.cb.onAssistantDone(ev.transcript);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.cb.onUserTranscript(ev.transcript);
        break;
      case 'response.output_item.done':
        if (ev.item?.type === 'function_call') this.#dispatchToolCall(ev.item);
        break;
      case 'response.done':
        // Fallback path in case output_item.done was missed.
        for (const item of ev.response?.output || []) {
          if (item.type === 'function_call') this.#dispatchToolCall(item);
        }
        break;
      case 'error':
        this.cb.onError(new Error(ev.error?.message || JSON.stringify(ev.error)));
        break;
    }
  }

  #dispatchToolCall(item) {
    if (this.handledCalls.has(item.call_id)) return;
    this.handledCalls.add(item.call_id);
    let args = {};
    try { args = JSON.parse(item.arguments || '{}'); } catch { /* leave empty */ }
    this.cb.onToolCall(item.name, args, item.call_id);
  }
}
