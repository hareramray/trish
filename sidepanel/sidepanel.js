// Side panel orchestrator: owns the mic/audio session, wires the voice
// provider to the page tools, and renders the transcript.
import { TOOL_DEFINITIONS, executeTool } from '../lib/tools.js';
import { detachAll, setDialogListener, watchForDialogs } from '../lib/cdp.js';
import { OpenAIRealtimeProvider } from '../lib/provider-openai.js';
import { GeminiLiveProvider } from '../lib/provider-gemini.js';

const els = {
  status: document.getElementById('status'),
  connect: document.getElementById('btn-connect'),
  mute: document.getElementById('btn-mute'),
  read: document.getElementById('btn-read'),
  stopRead: document.getElementById('btn-stop-read'),
  transcript: document.getElementById('transcript'),
  audio: document.getElementById('remote-audio'),
  options: document.getElementById('open-options')
};

let provider = null;
let assistantBubble = null; // streaming transcript bubble being appended to
let muted = false;

// ---------- UI helpers ----------

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = kind;
}

function addMsg(kind, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  div.textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
}

// ---------- settings & instructions ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    provider: 'gemini',
    model: 'gpt-realtime',
    geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
    geminiVisionModel: 'gemini-2.5-pro',
    geminiVoice: 'Puck',
    visionModel: 'gpt-5',
    voice: 'marin',
    language: '',
    openaiKey: '',
    geminiKey: '',
    ...settings
  };
}

function buildInstructions(settings) {
  return `
You are Trish, a voice assistant that helps blind and low-vision users browse
the web. You are connected to their current browser tab through tools.

Core behavior:
- Speak concisely. Screen reader users value speed; avoid filler and repetition.
- After every action, briefly say what happened ("Clicked Login. The page now
  shows a sign-in form.").
- When arriving on a new page, call get_page_overview before describing it.
- On browser-internal pages (new tab page, settings) the page tools cannot
  work. Do not apologize or ask the user to switch pages — just use search_web
  to search or navigate to open a site directly.
- When asked to click, fill, or find something, use list_interactive_elements
  or get_form_fields to locate it. If several elements match, read the options
  aloud and let the user pick by number. Never guess between ambiguous targets.
- For forms: use get_form_fields, then go field by field — announce the field
  ("Field 2 of 5: Email address"), ask for the value or use the saved profile
  via get_user_profile, fill it, and confirm what was entered. Support
  corrections at any time.
- SAFETY: before any irreversible action — submitting an order or payment,
  deleting anything, sending a message or application — read back exactly what
  will happen and wait for the user to say "confirm" or clearly agree. If they
  hesitate, do not act.
- Never read a password aloud, never ask the user to speak a password, and
  never fill password fields; tell them to type it on the keyboard (the field
  will already be focused).
- If click_element or fill_field has no effect (page unchanged, value didn't
  stick), retry once with click_element_trusted or type_text_trusted — they
  send real browser input that all sites accept. Mention that Chrome may show
  a "debugging" banner; it is harmless.
- If the DOM tools still can't find or reliably click something you can see —
  a button in a popup or modal, a language chooser, a canvas or framed widget
  — use click_on_screen with a clear description (e.g. "the English button in
  the language popup"). It uses a high-accuracy vision model to locate the
  exact spot and clicks it. Use find_on_screen when you need a field's
  coordinates before typing with type_at_coordinates.
- CRITICAL: you cannot see the screen yourself, so NEVER pass coordinates you
  guessed to click_at_coordinates or type_at_coordinates — that clicks the
  wrong place. To click something visible, use click_on_screen. Only use
  click_at_coordinates / type_at_coordinates with coordinates that came back
  from find_on_screen or solve_captcha.
- When the user asks about something visual — a photo, chart, map, video
  thumbnail, or a page the text tools can't parse — call look_at_page (it uses
  a high-accuracy vision model to describe the screen), then relay it.
- CAPTCHAS: a captcha is a visual barrier the user cannot solve themselves, so
  helping is part of your job. Call solve_captcha — it uses a dedicated,
  high-accuracy vision model to return the challenge type, its instruction, any
  transcribed text, and exact pixel coordinates (checkbox, matching tiles,
  Verify button). Then act with click_at_coordinates / type_at_coordinates.
  Typical flows: (1) "I'm not a robot" — click the checkbox coordinate; often
  that is all that's needed. (2) Image challenge ("select all crosswalks") —
  tell the user what it asks, click each returned tile coordinate, click the
  Verify coordinate, then call solve_captcha again in case new tiles loaded.
  (3) Text/audio captcha — read the transcribed text to the user, then
  type_at_coordinates into the answer box. Narrate what you see and what you're
  clicking as you go. Never type a password this way. (look_at_page is still
  fine for describing ordinary images; solve_captcha is the one to use for
  captchas.)
- BROWSER DIALOGS: if a native alert, confirm, or prompt opens, you are told
  automatically and the page is frozen until it is answered. Read it to the
  user first. Dismiss an alert with handle_dialog accept:true. For a confirm,
  ask the user and only accept:true if they clearly agree, else accept:false.
  For a prompt, ask what to enter and pass it as text. Resolve the dialog
  before doing anything else — no other tool will work while it is open.
  ("Leave site?" / redirect confirmations are accepted automatically so pages
  navigate normally; you will not be asked about those.)
- If a tool reports an error, explain it simply and suggest what to try next.
- The user cannot see the screen. Never say "as you can see" or refer to
  colors/positions without also giving the text.
${settings.language ? `- Speak in ${settings.language} unless the user switches language.` : '- Match the language the user speaks to you.'}
`.trim();
}

// ---------- voice session ----------

async function startSession() {
  const settings = await getSettings();

  const isGemini = settings.provider === 'gemini';
  if (isGemini && !settings.geminiKey) {
    setStatus('No API key. Open Settings and add your Gemini key.', 'error');
    addMsg('system', 'Add your Gemini API key on the Settings page, then try again.');
    speakLocal('No API key set. Please open the settings page and add your Gemini API key.');
    return;
  }
  if (!isGemini && !settings.openaiKey) {
    setStatus('No API key. Open Settings and add your OpenAI key.', 'error');
    addMsg('system', 'Add your OpenAI API key on the Settings page, then try again.');
    speakLocal('No API key set. Please open the settings page and add your OpenAI API key.');
    return;
  }

  const callbacks = {
    onStatus: (t) => setStatus(t, 'connected'),
    onUserTranscript: (t) => { if (t?.trim()) addMsg('user', t.trim()); },
    onAssistantDelta: (d) => {
      if (!assistantBubble) assistantBubble = addMsg('assistant', '');
      assistantBubble.textContent += d;
      els.transcript.scrollTop = els.transcript.scrollHeight;
    },
    onAssistantDone: () => { assistantBubble = null; },
    onToolCall: handleToolCall,
    onError: (err) => {
      addMsg('system', 'Error: ' + err.message);
      setStatus('Error — see transcript', 'error');
    },
    onClosed: () => endSession('Connection lost')
  };

  const opts = {
    apiKey: isGemini ? settings.geminiKey : settings.openaiKey,
    model: isGemini ? settings.geminiModel : settings.model,
    voice: isGemini ? settings.geminiVoice : settings.voice,
    instructions: buildInstructions(settings),
    tools: TOOL_DEFINITIONS,
    callbacks
  };

  provider = isGemini
    ? new GeminiLiveProvider(opts)
    : new OpenAIRealtimeProvider(opts);

  els.connect.disabled = true;
  try {
    await provider.connect(els.audio);
    // Attach the debugger now so native dialogs are caught the moment they
    // open — before an ordinary click can freeze the page on one.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await watchForDialogs(tab.id);
    } catch { /* restricted tab (e.g. new tab page); attaches later on demand */ }
    els.connect.textContent = 'End voice session';
    els.mute.hidden = false;
    muted = false;
    els.mute.setAttribute('aria-pressed', 'false');
    els.mute.textContent = 'Mute microphone';
  } catch (err) {
    provider = null;
    setStatus('Could not connect', 'error');
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' ||
        /permission (denied|dismissed)/i.test(err.message)) {
      // Side panels often can't show the mic prompt; a normal tab can.
      addMsg('system',
        'Microphone access is blocked for Trish. I opened a setup tab — click ' +
        '"Enable microphone" there and choose Allow, then come back and press ' +
        '"Start voice session" again.');
      speakLocal('Microphone access is blocked. I opened a setup tab. Please ' +
        'click enable microphone there and choose allow, then try again.');
      chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
    } else if (err.name === 'NotFoundError') {
      addMsg('system', 'No microphone was found. Connect a microphone and try again.');
      speakLocal('No microphone was found. Please connect a microphone and try again.');
    } else {
      addMsg('system', `${err.name ? err.name + ': ' : ''}${err.message}`);
      speakLocal('Could not connect. ' + err.message);
    }
  } finally {
    els.connect.disabled = false;
  }
}

function endSession(reason = 'Session ended') {
  provider?.disconnect();
  provider = null;
  detachAll(); // release the debugger so Chrome's banner goes away
  assistantBubble = null;
  els.connect.textContent = 'Start voice session';
  els.mute.hidden = true;
  setStatus(reason);
}

async function handleToolCall(name, args, callId) {
  addMsg('tool', `→ ${name}(${JSON.stringify(args)})`);
  let result;
  try {
    result = await executeTool(name, args);
  } catch (err) {
    result = { error: err.message };
  }
  // Screenshots ride along as an image item so the model can actually see it;
  // the tool result itself stays small text.
  if (result && result.__image) {
    const { __image, ...rest } = result;
    provider?.sendImage(__image);
    result = rest;
  }
  provider?.sendToolResult(callId, JSON.stringify(result));
}

// ---------- offline read-aloud (free fallback, no API needed) ----------

let reading = false;

async function readAloud() {
  const settings = await getSettings();
  try {
    reading = true;
    els.read.hidden = true;
    els.stopRead.hidden = false;
    setStatus('Reading page aloud…');
    let offset = 0;
    while (reading) {
      const chunk = await executeTool('read_page_content', { offset });
      if (!chunk.text) break;
      await speakLocal(chunk.text, settings.language);
      if (chunk.nextOffset == null) break;
      offset = chunk.nextOffset;
    }
  } catch (err) {
    addMsg('system', 'Read aloud failed: ' + err.message);
  } finally {
    reading = false;
    els.read.hidden = false;
    els.stopRead.hidden = true;
    setStatus(provider?.connected ? 'Connected — listening' : 'Not connected',
      provider?.connected ? 'connected' : '');
  }
}

function speakLocal(text, language) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    if (language) u.lang = language;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

function stopReading() {
  reading = false;
  speechSynthesis.cancel();
}

// ---------- wiring ----------

els.connect.addEventListener('click', () => {
  provider ? endSession() : startSession();
});

els.mute.addEventListener('click', () => {
  if (!provider) return;
  muted = !muted;
  provider.setMicEnabled(!muted);
  els.mute.setAttribute('aria-pressed', String(muted));
  els.mute.textContent = muted ? 'Unmute microphone' : 'Mute microphone';
  setStatus(muted ? 'Connected — microphone muted' : 'Connected — listening', 'connected');
});

els.read.addEventListener('click', readAloud);
els.stopRead.addEventListener('click', stopReading);
els.options.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// A native browser dialog opened on the page. Surface it to the user and tell
// the model to read it out and resolve it with handle_dialog.
setDialogListener((_tabId, info) => {
  const label = info.type === 'beforeunload' ? 'leave-page warning' : info.type;
  const text = info.message ||
    (info.type === 'beforeunload' ? 'The site is asking you to confirm leaving this page.' : '');
  addMsg('system', `Browser dialog (${label}): ${text}`);
  if (provider) {
    const guidance = info.type === 'prompt'
      ? `It is asking for text input (suggested default: "${info.defaultPrompt}"). Read it to the user, ask what to enter, then call handle_dialog with accept:true and their text — or accept:false to cancel.`
      : info.type === 'alert'
        ? 'Read it to the user, then call handle_dialog with accept:true to dismiss it.'
        : 'Read it to the user and ask whether to proceed. Only call handle_dialog with accept:true if they clearly agree; otherwise call it with accept:false.';
    provider.sendSystemNote(
      `A native browser ${info.type} dialog just opened and is blocking the ` +
      `page. It says: "${text}". ${guidance}`
    );
    provider.requestResponse?.();
  } else {
    // No live session to decide — read it aloud so the user isn't left stuck.
    speakLocal(`A browser dialog says: ${text}`);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TRISH_TOGGLE_VOICE') {
    provider ? endSession() : startSession();
  } else if (msg?.type === 'TRISH_LIVE_REGION') {
    addMsg('system', 'Page announcement: ' + msg.text);
    // Give the model the context; it will mention it when relevant.
    provider?.sendSystemNote('The page just announced: "' + msg.text + '"');
  }
});

window.addEventListener('unload', () => {
  provider?.disconnect();
  detachAll();
});

// First-run hint
getSettings().then(s => {
  if (!s.openaiKey && !s.geminiKey) {
    addMsg('system',
      'Welcome! Open Settings to add your OpenAI API key, then press ' +
      '"Start voice session" or Alt+Shift+V. "Read page aloud" works without a key.');
  }
});
