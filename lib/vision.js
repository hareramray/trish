// All vision-related tasks route through one strong, configurable model, using
// whichever provider is selected: Gemini 2.5 Pro (default) or OpenAI GPT-5.
// This is deliberately separate from the realtime voice model, which is weaker
// at reading text and — most importantly — pinning the pixel coordinates needed
// to click something precisely (e.g. a small "English" button).

async function openaiVision(settings, { system, userText, dataUrl, json }) {
  const apiKey = settings?.openaiKey;
  if (!apiKey) throw new Error('No OpenAI API key set. Add one on the Trish Settings page to use vision.');
  const model = (settings?.visionModel || '').trim() || 'gpt-5';

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }
    ]
  };
  if (json) body.response_format = { type: 'json_object' };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`OpenAI vision model "${model}" failed (HTTP ${resp.status}). ${t.slice(0, 200)} — check the model name on the Settings page.`);
  }
  const data = await resp.json();
  return { model, content: data.choices?.[0]?.message?.content || '' };
}

async function geminiVision(settings, { system, userText, dataUrl, json }) {
  const apiKey = settings?.geminiKey;
  if (!apiKey) throw new Error('No Gemini API key set. Add one on the Trish Settings page to use vision.');
  const model = (settings?.geminiVisionModel || '').trim() || 'gemini-2.5-pro';
  const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl || '');
  if (!m) throw new Error('Invalid screenshot data for vision.');

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }, { inlineData: { mimeType: m[1], data: m[2] } }] }]
  };
  if (json) body.generationConfig = { responseMimeType: 'application/json' };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Gemini vision model "${model}" failed (HTTP ${resp.status}). ${t.slice(0, 200)} — check the model name on the Settings page.`);
  }
  const data = await resp.json();
  const content = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('');
  return { model, content };
}

async function runVision(args) {
  const { settings } = await chrome.storage.local.get('settings');
  const provider = settings?.provider || 'gemini';
  return provider === 'openai' ? openaiVision(settings, args) : geminiVision(settings, args);
}

function parseJson(content, what) {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`The vision model did not return valid JSON for ${what}; try again or pick a different vision model.`);
  }
}

const DESCRIBE_SYSTEM =
  'You are the eyes of a voice assistant for a blind user. Answer clearly and ' +
  'concisely in plain sentences. Read important on-screen text verbatim. Do not ' +
  'mention pixels or coordinates.';

export async function describeImage(dataUrl, { width, height }, question) {
  const q = (question || '').trim() ||
    'Describe what is visually relevant on this screen for a blind user, concisely, and read any important on-screen text.';
  const { model, content } = await runVision({
    system: DESCRIBE_SYSTEM,
    userText: `The screen is ${width}x${height} pixels. ${q}`,
    dataUrl
  });
  return { model, description: content };
}

const LOCATE_SYSTEM = `You locate a UI element in a screenshot so a blind user's assistant can click it. You get the screenshot, its exact pixel size, and a description of the target. Reply as STRICT JSON (no prose, no markdown):
{
  "found": boolean,
  "x": number,               // center X in pixels from the LEFT edge, within image bounds
  "y": number,               // center Y in pixels from the TOP edge, within image bounds
  "label": string,           // the visible text/description of what you located
  "confidence": "high" | "medium" | "low",
  "note": string             // alternatives if ambiguous, or why not found
}
Coordinates MUST be inside the image (0..width, 0..height) and at the CENTER of the clickable target. If several things match, choose the best and list the others in note. If the target is not visible, set found=false.`;

export async function locateTarget(dataUrl, { width, height }, description) {
  const { model, content } = await runVision({
    system: LOCATE_SYSTEM,
    userText: `Screenshot is ${width}x${height} pixels. Find and give the center coordinates of: "${description}". Reply as JSON.`,
    dataUrl,
    json: true
  });
  return { model, ...parseJson(content, 'element location') };
}

const CAPTCHA_SYSTEM = `You are a precise vision analyst helping a blind user get past a CAPTCHA on a web page. You are given a screenshot and its exact pixel size. Report only what you can actually see — never invent coordinates.

Reply as STRICT JSON (no prose, no markdown fences) with exactly this shape:
{
  "captcha_present": boolean,
  "captcha_type": "checkbox" | "image_grid" | "text" | "audio" | "slider" | "unknown" | "none",
  "instruction": string,          // the challenge wording, e.g. "Select all images with buses"; "" if none
  "transcribed_text": string,     // for a distorted-text captcha, the characters you read; else ""
  "targets": [                    // things to click; center pixel coords from the TOP-LEFT of the image
    { "label": string, "x": number, "y": number }
  ],
  "controls": {                   // each null if not visible
    "verify": { "x": number, "y": number } | null,
    "reload": { "x": number, "y": number } | null,
    "audio":  { "x": number, "y": number } | null
  },
  "confidence": "high" | "medium" | "low",
  "notes": string                 // anything the user should know
}

Rules:
- All coordinates MUST be within the image bounds (0..width, 0..height).
- image_grid: include one target per tile that matches the instruction (empty array if none match). Also fill controls.verify with the Verify/Skip button.
- checkbox: put the "I'm not a robot" checkbox as the single target.
- text: put the characters in transcribed_text and leave targets empty.
- If there is no captcha, set captcha_present false and captcha_type "none".`;

export async function analyzeCaptcha(dataUrl, { width, height }) {
  const { model, content } = await runVision({
    system: CAPTCHA_SYSTEM,
    userText: `The screenshot is ${width}x${height} pixels. Analyze it for a CAPTCHA and reply as JSON.`,
    dataUrl,
    json: true
  });
  return { model, ...parseJson(content, 'captcha analysis') };
}
