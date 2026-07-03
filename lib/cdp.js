// Chrome DevTools Protocol helper via chrome.debugger — the same engine
// Playwright/DevTools use. Gives trusted input events (which sites cannot
// distinguish from a real user) and screenshots.
//
// Note: while attached, Chrome shows an infobar saying the extension
// "started debugging this browser". That is expected; we detach when the
// voice session ends.

const attached = new Set();

// A native JS dialog (alert/confirm/prompt/beforeunload) blocks the page's
// main thread — and therefore the content script — until it is answered. We
// answer it with Page.handleJavaScriptDialog, which the browser process runs
// even while the renderer is frozen. Pending dialogs are keyed by tabId.
const pendingDialogs = new Map(); // tabId -> { type, message, defaultPrompt, url }
let dialogListener = null;

export function setDialogListener(fn) { dialogListener = fn; }
export function getPendingDialog(tabId) { return pendingDialogs.get(tabId) || null; }
export function anyPendingDialog() {
  for (const [tabId, info] of pendingDialogs) return { tabId, ...info };
  return null;
}

// If a dialog is never answered (model busy, user walked away), auto-dismiss
// it after this long so a tab can't stay frozen forever.
const DIALOG_TIMEOUT_MS = 30000;

function clearDialog(tabId) {
  const info = pendingDialogs.get(tabId);
  if (info?.timer) clearTimeout(info.timer);
  pendingDialogs.delete(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => {
  attached.delete(tabId);
  clearDialog(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === 'Page.javascriptDialogOpening') {
    // Once Page is enabled, Chrome suppresses the native dialog and waits for
    // us to answer — so an unanswered dialog blocks the whole page.
    // beforeunload ("Leave site?" / redirect interstitials) must never trap
    // the page: accept immediately so navigations and redirects proceed, and
    // don't involve the model.
    if (params.type === 'beforeunload') {
      send(tabId, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      return;
    }
    const info = {
      type: params.type,                       // alert | confirm | prompt
      message: params.message || '',
      defaultPrompt: params.defaultPrompt || '',
      url: params.url || ''
    };
    // Safety net: if nothing resolves it in time, dismiss so the page recovers
    // (accept an alert; cancel a confirm/prompt).
    info.timer = setTimeout(() => {
      if (pendingDialogs.get(tabId) === info) {
        handleDialog(tabId, info.type === 'alert', undefined).catch(() => {});
      }
    }, DIALOG_TIMEOUT_MS);
    pendingDialogs.set(tabId, info);
    try { dialogListener?.(tabId, info); } catch { /* listener errors are non-fatal */ }
  } else if (method === 'Page.javascriptDialogClosed') {
    clearDialog(tabId);
  }
});

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  // Page domain must be enabled for javascriptDialogOpening events to fire.
  try { await send(tabId, 'Page.enable'); } catch { /* restricted target */ }
}

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Some CDP commands (notably Page.captureScreenshot) can hang forever if the
// target can't produce a frame — a backgrounded/occluded tab, or a renderer
// blocked on a dialog. Race every such call against a timeout so a stall turns
// into a recoverable error instead of freezing the whole assistant.
function sendWithTimeout(tabId, method, params = {}, ms = 12000) {
  return Promise.race([
    send(tabId, method, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${method} timed out after ${ms}ms`)), ms))
  ]);
}

// Attach up front (at session start) so dialogs are intercepted the instant
// they open — including ones raised by an ordinary synthetic click, which
// would otherwise freeze the content script before we could react.
export async function watchForDialogs(tabId) {
  await ensureAttached(tabId);
}

export async function handleDialog(tabId, accept, promptText) {
  await ensureAttached(tabId);
  const params = { accept };
  if (promptText != null) params.promptText = promptText;
  await send(tabId, 'Page.handleJavaScriptDialog', params);
  clearDialog(tabId);
}

export async function detachAll() {
  for (const tabId of [...attached]) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* tab gone */ }
    attached.delete(tabId);
  }
  for (const tabId of [...pendingDialogs.keys()]) clearDialog(tabId);
}

// x/y are viewport CSS pixels (matches getBoundingClientRect coordinates).
export async function trustedClick(tabId, x, y) {
  await ensureAttached(tabId);
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

const CTRL = 2; // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

async function selectAll(tabId) {
  const key = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: CTRL };
  await send(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyDown' });
  await send(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
}

// Types into whatever element currently has focus. insertText is trusted and
// fires proper input events, so frameworks and rich editors accept it.
export async function trustedType(tabId, text, { clearFirst = false } = {}) {
  await ensureAttached(tabId);
  if (clearFirst) await selectAll(tabId);
  await send(tabId, 'Input.insertText', { text });
}

export async function trustedEnter(tabId) {
  await ensureAttached(tabId);
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  await send(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'rawKeyDown' });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: '\r' });
  await send(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
}

// Captures the visible viewport and returns the image plus its size in CSS
// pixels. We clip to the visual viewport at scale 1 so the image is exactly
// cssWidth x cssHeight regardless of the device pixel ratio — that means a
// pixel the model points at in the screenshot maps 1:1 to the coordinates
// trustedClick/trustedType expect. Needed for clicking things the DOM snapshot
// can't reach (canvas UIs, cross-origin captcha widgets).
export async function screenshot(tabId) {
  await ensureAttached(tabId);
  // Activate the tab first: a tab that isn't the frontmost/visible one may not
  // composite, and then captureScreenshot never returns. This is the usual
  // cause of look_at_page hanging.
  try { await sendWithTimeout(tabId, 'Page.bringToFront', {}, 4000); } catch { /* best effort */ }

  let width = 0, height = 0, clip;
  try {
    const metrics = await sendWithTimeout(tabId, 'Page.getLayoutMetrics', {}, 4000);
    const vp = metrics.cssVisualViewport || metrics.visualViewport || {};
    width = Math.max(1, Math.floor(vp.clientWidth || 0));
    height = Math.max(1, Math.floor(vp.clientHeight || 0));
    if (width && height) clip = { x: vp.pageX || 0, y: vp.pageY || 0, width, height, scale: 1 };
  } catch { /* fall back to a plain viewport capture below */ }

  const params = { format: 'jpeg', quality: 60, captureBeyondViewport: false };
  if (clip) params.clip = clip;
  const { data } = await sendWithTimeout(tabId, 'Page.captureScreenshot', params, 12000);
  return { dataUrl: 'data:image/jpeg;base64,' + data, width, height };
}
