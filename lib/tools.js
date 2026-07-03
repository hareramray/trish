// Tool definitions exposed to the voice model, and the executor that routes
// each call to the content script in the active tab (or to local data).

import {
  trustedClick, trustedType, trustedEnter, screenshot,
  getPendingDialog, anyPendingDialog, handleDialog
} from './cdp.js';
import { analyzeCaptcha, describeImage, locateTarget } from './vision.js';

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'get_page_overview',
    description:
      'Get a structured overview of the current page: title, URL, headings, ' +
      'landmarks, element counts, and a preview of the main content. Call this ' +
      'first on a new page, and again after any click or navigation that may ' +
      'have changed the page.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'list_interactive_elements',
    description:
      'List clickable/fillable elements (links, buttons, inputs...) with short ' +
      'ids like "e12" used by the action tools. Optionally filter by a keyword ' +
      'matched against the element name or role.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional keyword, e.g. "login" or "search"' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'read_page_content',
    description:
      'Get the readable main content of the page as text, in chunks. Use offset ' +
      'from the previous result to continue reading long pages.',
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'integer', description: 'Character offset to continue from (default 0)' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'get_form_fields',
    description:
      'List all form fields on the page with their labels, types, current ' +
      'values, dropdown options, and element ids. Use before filling a form.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'click_element',
    description:
      'Click an element by its id from list_interactive_elements or ' +
      'get_form_fields. For irreversible actions (submitting orders, payments, ' +
      'deleting things, sending messages) you MUST get spoken confirmation from ' +
      'the user first.',
    parameters: {
      type: 'object',
      properties: { element_id: { type: 'string' } },
      required: ['element_id']
    }
  },
  {
    type: 'function',
    name: 'fill_field',
    description: 'Type a value into a text input, textarea, or editable area.',
    parameters: {
      type: 'object',
      properties: {
        element_id: { type: 'string' },
        value: { type: 'string' }
      },
      required: ['element_id', 'value']
    }
  },
  {
    type: 'function',
    name: 'select_option',
    description: 'Choose an option in a dropdown (select) by its visible text.',
    parameters: {
      type: 'object',
      properties: {
        element_id: { type: 'string' },
        option: { type: 'string', description: 'Visible text of the option to select' }
      },
      required: ['element_id', 'option']
    }
  },
  {
    type: 'function',
    name: 'set_checkbox',
    description: 'Check or uncheck a checkbox, radio button, or switch.',
    parameters: {
      type: 'object',
      properties: {
        element_id: { type: 'string' },
        checked: { type: 'boolean' }
      },
      required: ['element_id', 'checked']
    }
  },
  {
    type: 'function',
    name: 'press_enter',
    description:
      'Press Enter in a field (e.g. to submit a search box). Submits the ' +
      'surrounding form, so confirm with the user if the form is consequential.',
    parameters: {
      type: 'object',
      properties: { element_id: { type: 'string' } },
      required: ['element_id']
    }
  },
  {
    type: 'function',
    name: 'scroll_page',
    description: 'Scroll the page.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }
      },
      required: ['direction']
    }
  },
  {
    type: 'function',
    name: 'navigate',
    description:
      'Navigate the current tab: open a URL, or go back/forward/reload.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['url', 'back', 'forward', 'reload'] },
        url: { type: 'string', description: 'Required when action is "url"' }
      },
      required: ['action']
    }
  },
  {
    type: 'function',
    name: 'click_element_trusted',
    description:
      'Click an element using a real, trusted mouse event via the browser\'s ' +
      'debugger (like Playwright). Use when click_element had no effect — some ' +
      'sites ignore synthetic clicks. Chrome will show a "started debugging" ' +
      'banner; that is expected. The same confirmation rules as click_element ' +
      'apply to irreversible actions.',
    parameters: {
      type: 'object',
      properties: { element_id: { type: 'string' } },
      required: ['element_id']
    }
  },
  {
    type: 'function',
    name: 'type_text_trusted',
    description:
      'Type into a field using trusted keyboard input via the browser\'s ' +
      'debugger. Use when fill_field did not stick (rich text editors, Google ' +
      'Docs, stubborn React forms). Set clear_first to replace existing text.',
    parameters: {
      type: 'object',
      properties: {
        element_id: { type: 'string' },
        text: { type: 'string' },
        clear_first: { type: 'boolean', description: 'Select all and replace existing content first' },
        press_enter_after: { type: 'boolean', description: 'Press Enter after typing (e.g. to submit a search)' }
      },
      required: ['element_id', 'text']
    }
  },
  {
    type: 'function',
    name: 'look_at_page',
    description:
      'Screenshot the visible page and have a high-accuracy vision model ' +
      'describe it, returning the description as text. Use to describe images, ' +
      'charts, maps, canvas apps, or anything the text snapshot cannot capture ' +
      '— e.g. "what does this picture show?". Pass an optional question to ask ' +
      'about something specific. To CLICK something you can see, use ' +
      'click_on_screen; for captchas use solve_captcha.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Optional specific question about the screen' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'find_on_screen',
    description:
      'Locate a UI element by description using the best vision model and get ' +
      'its center pixel coordinates, for click_at_coordinates / ' +
      'type_at_coordinates. Use when you need the coordinates without clicking ' +
      'yet — e.g. to find a field before typing into it.',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string', description: 'What to find, e.g. "the search box"' } },
      required: ['description']
    }
  },
  {
    type: 'function',
    name: 'click_on_screen',
    description:
      'Locate an element by description with the best vision model and click it ' +
      'with a trusted mouse click. This is the reliable way to click something ' +
      'the DOM tools miss or mis-target — buttons inside modals/overlays, ' +
      'canvas, or frames. Example: "the English button in the language popup". ' +
      'The same confirmation rules as click_element apply to irreversible ' +
      'actions.',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string', description: 'What to click, e.g. "the English button"' } },
      required: ['description']
    }
  },
  {
    type: 'function',
    name: 'solve_captcha',
    description:
      'Analyze the current screen for a CAPTCHA using a dedicated high-accuracy ' +
      'vision model — much better than your own vision at reading distorted ' +
      'text and locating grid tiles. Use this whenever a captcha appears. It ' +
      'returns the captcha type, the challenge instruction, any transcribed ' +
      'text, and pixel coordinates (the checkbox, each matching tile, the ' +
      'Verify button) ready for click_at_coordinates / type_at_coordinates. ' +
      'Read the result to the user, then act. Re-run it after clicking grid ' +
      'tiles, since new tiles often load in.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'click_at_coordinates',
    description:
      'Send a real, trusted mouse click at pixel coordinates (x, y). Use this ' +
      'ONLY with coordinates returned by solve_captcha or find_on_screen — you ' +
      'cannot see the screen yourself, so never estimate coordinates. To click ' +
      'something you can see but have no coordinates for, use click_on_screen ' +
      'instead (it finds the exact spot and clicks it). The same confirmation ' +
      'rules as click_element apply to irreversible actions.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Horizontal pixel from the left edge of the screenshot' },
        y: { type: 'integer', description: 'Vertical pixel from the top edge of the screenshot' }
      },
      required: ['x', 'y']
    }
  },
  {
    type: 'function',
    name: 'type_at_coordinates',
    description:
      'Trusted click at pixel coordinates (x, y) to focus a field, then type ' +
      'text into it. Use ONLY with coordinates from find_on_screen or ' +
      'solve_captcha — never coordinates you estimated. Get a field\'s ' +
      'coordinates with find_on_screen first. Good for input boxes the DOM ' +
      'tools cannot reach (e.g. a captcha answer box in a frame). Refuses ' +
      'password fields.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Horizontal pixel of the field from the screenshot' },
        y: { type: 'integer', description: 'Vertical pixel of the field from the screenshot' },
        text: { type: 'string' },
        press_enter_after: { type: 'boolean', description: 'Press Enter after typing (e.g. to submit)' }
      },
      required: ['x', 'y', 'text']
    }
  },
  {
    type: 'function',
    name: 'search_web',
    description:
      'Search the web: opens the search results page directly. ALWAYS use this ' +
      'instead of trying to type into the new-tab-page search box or the ' +
      'address bar — those are browser UI that no tool can reach.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        engine: {
          type: 'string',
          enum: ['google', 'bing', 'duckduckgo'],
          description: 'Default google'
        }
      },
      required: ['query']
    }
  },
  {
    type: 'function',
    name: 'handle_dialog',
    description:
      'Answer a native browser dialog (alert, confirm, or prompt) that has ' +
      'popped up and is blocking the page. The user is told when one opens. ' +
      'For an alert, accept:true dismisses it. For a confirm, accept:true is ' +
      'OK and accept:false is Cancel — get the user\'s agreement first for ' +
      'anything irreversible. For a prompt, accept:true with text submits that ' +
      'text. Nothing else on the page will respond until the dialog is ' +
      'handled. (You will not see "Leave site?" redirect warnings — those are ' +
      'accepted automatically.)',
    parameters: {
      type: 'object',
      properties: {
        accept: { type: 'boolean', description: 'true = OK/Leave/submit; false = Cancel/Stay' },
        text: { type: 'string', description: 'Text to enter, for a prompt dialog only' }
      },
      required: ['accept']
    }
  },
  {
    type: 'function',
    name: 'where_am_i',
    description:
      'Report the current page title, URL, scroll position, and focused element.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'get_user_profile',
    description:
      'Get the user\'s saved profile (name, email, phone, address) for filling ' +
      'forms. Contains no passwords. Tell the user which saved values you are ' +
      'using.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
];

const RESTRICTED_PREFIXES = [
  'chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://',
  'view-source:', 'https://chromewebstore.google.com', 'https://chrome.google.com/webstore'
];

// requirePageAccess guards tools that read or act on page content. Tools that
// only retarget the tab (navigate) work fine even on chrome:// pages like the
// new tab page, so they skip the check.
async function activeTab({ requirePageAccess = true } = {}) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active browser tab found.');
  if (requirePageAccess && RESTRICTED_PREFIXES.some(p => (tab.url || '').startsWith(p))) {
    throw new Error(
      'This is a browser-internal page whose content extensions cannot read ' +
      'or control. You can still use the navigate tool to open a website URL ' +
      'here, or ask the user to switch to a normal web page.'
    );
  }
  return tab;
}

async function sendToPage(message) {
  const tab = await activeTab();
  const payload = { type: 'TRISH_PAGE', ...message };
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    // Content script not present (page loaded before install, or a race after
    // navigation) — inject and retry once.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content.js']
    });
    return await chrome.tabs.sendMessage(tab.id, payload);
  }
}

async function pageCall(message) {
  const resp = await sendToPage(message);
  if (!resp) throw new Error('No response from the page.');
  if (!resp.ok) throw new Error(resp.error);
  return resp.data;
}

const PAGE_CHANGE_NOTE =
  'If this changed the page, call get_page_overview to see the new state before telling the user what happened.';

export async function executeTool(name, args = {}) {
  switch (name) {
    case 'get_page_overview':
      return pageCall({ action: 'overview' });
    case 'list_interactive_elements':
      return pageCall({ action: 'elements', filter: args.filter });
    case 'read_page_content':
      return pageCall({ action: 'read', offset: args.offset });
    case 'get_form_fields':
      return pageCall({ action: 'form_fields' });
    case 'click_element': {
      const result = await pageCall({ action: 'click', element_id: args.element_id });
      return { ...result, note: PAGE_CHANGE_NOTE };
    }
    case 'fill_field':
      return pageCall({ action: 'fill', element_id: args.element_id, value: args.value });
    case 'select_option':
      return pageCall({ action: 'select_option', element_id: args.element_id, option: args.option });
    case 'set_checkbox':
      return pageCall({ action: 'set_checkbox', element_id: args.element_id, checked: args.checked });
    case 'press_enter': {
      const result = await pageCall({ action: 'press_enter', element_id: args.element_id });
      return { ...result, note: PAGE_CHANGE_NOTE };
    }
    case 'click_element_trusted': {
      const tab = await activeTab();
      const { x, y, name: elName } =
        await pageCall({ action: 'rect', element_id: args.element_id });
      await trustedClick(tab.id, x, y);
      return { clicked: elName || args.element_id, trusted: true, note: PAGE_CHANGE_NOTE };
    }
    case 'type_text_trusted': {
      const tab = await activeTab();
      const target = await pageCall({ action: 'focus_el', element_id: args.element_id });
      if (target.isPassword) {
        throw new Error(
          'For security, Trish does not type into password fields. The field ' +
          'is focused; ask the user to type their password on the keyboard.'
        );
      }
      if (!target.focused) {
        // Some widgets only accept focus from a real click — do that first.
        const { x, y } = await pageCall({ action: 'rect', element_id: args.element_id });
        await trustedClick(tab.id, x, y);
      }
      await trustedType(tab.id, String(args.text ?? ''), { clearFirst: Boolean(args.clear_first) });
      if (args.press_enter_after) await trustedEnter(tab.id);
      return {
        typedInto: target.name || args.element_id,
        text: args.text,
        pressedEnter: Boolean(args.press_enter_after),
        note: args.press_enter_after ? PAGE_CHANGE_NOTE : undefined
      };
    }
    case 'look_at_page': {
      const tab = await activeTab();
      const shot = await screenshot(tab.id);
      const { model, description } = await describeImage(shot.dataUrl, shot, args.question);
      return {
        description,
        visionModel: model,
        note: 'Read this to the user. To click something you see, use click_on_screen.'
      };
    }
    case 'find_on_screen': {
      const tab = await activeTab();
      const shot = await screenshot(tab.id);
      const loc = await locateTarget(shot.dataUrl, shot, String(args.description ?? ''));
      return {
        ...loc,
        imageWidth: shot.width,
        imageHeight: shot.height,
        note: loc.found
          ? 'Center coordinates are ready for click_at_coordinates / type_at_coordinates.'
          : 'Not found on the visible screen — try scrolling, or describe it differently.'
      };
    }
    case 'click_on_screen': {
      const tab = await activeTab();
      const shot = await screenshot(tab.id);
      const loc = await locateTarget(shot.dataUrl, shot, String(args.description ?? ''));
      if (!loc.found) {
        return { found: false, note: loc.note || 'Could not find that on the visible screen.' };
      }
      const x = Math.min(Math.max(Math.round(loc.x), 1), shot.width - 1);
      const y = Math.min(Math.max(Math.round(loc.y), 1), shot.height - 1);
      await trustedClick(tab.id, x, y);
      return {
        clicked: loc.label || String(args.description ?? ''),
        at: { x, y },
        confidence: loc.confidence,
        visionModel: loc.model,
        trusted: true,
        note: PAGE_CHANGE_NOTE
      };
    }
    case 'solve_captcha': {
      const tab = await activeTab();
      const shot = await screenshot(tab.id);
      const analysis = await analyzeCaptcha(shot.dataUrl, shot);
      return {
        ...analysis,
        imageWidth: shot.width,
        imageHeight: shot.height,
        note:
          'Coordinates are pixels from the top-left of this screenshot, ready ' +
          'for click_at_coordinates / type_at_coordinates. Tell the user what ' +
          'the captcha asks and what you will click before acting. After ' +
          'clicking grid tiles, call solve_captcha again — new tiles may load.'
      };
    }
    case 'click_at_coordinates': {
      const tab = await activeTab();
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('x and y must be numbers (pixels from the look_at_page screenshot).');
      }
      await trustedClick(tab.id, x, y);
      return { clickedAt: { x, y }, trusted: true, note: PAGE_CHANGE_NOTE };
    }
    case 'type_at_coordinates': {
      const tab = await activeTab();
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('x and y must be numbers (pixels from the look_at_page screenshot).');
      }
      await trustedClick(tab.id, x, y);
      // Best-effort password guard: if the click focused a password field in
      // the top document, refuse. (Cross-origin frames hide their focus from
      // us, but captcha answer boxes are never passwords, so this is fine.)
      const here = await pageCall({ action: 'where_am_i' });
      if (here.focusedElement?.role === 'password') {
        throw new Error(
          'That is a password field. For security, Trish does not type ' +
          'passwords. The field is focused; ask the user to type it themselves.'
        );
      }
      await trustedType(tab.id, String(args.text ?? ''), { clearFirst: false });
      if (args.press_enter_after) await trustedEnter(tab.id);
      return {
        typedAt: { x, y },
        text: args.text,
        pressedEnter: Boolean(args.press_enter_after),
        note: args.press_enter_after ? PAGE_CHANGE_NOTE : undefined
      };
    }
    case 'scroll_page':
      return pageCall({ action: 'scroll', direction: args.direction });
    case 'search_web': {
      const tab = await activeTab({ requirePageAccess: false });
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query is required.');
      const engines = {
        google: 'https://www.google.com/search?q=',
        bing: 'https://www.bing.com/search?q=',
        duckduckgo: 'https://duckduckgo.com/?q='
      };
      const base = engines[args.engine] || engines.google;
      const url = base + encodeURIComponent(query);
      await chrome.tabs.update(tab.id, { url });
      return { searching: query, url, note: PAGE_CHANGE_NOTE };
    }
    case 'handle_dialog': {
      const tab = await activeTab({ requirePageAccess: false });
      let tabId = tab.id;
      let pending = getPendingDialog(tabId);
      if (!pending) {
        // The blocked tab may not be the "active" one Chrome reports; fall
        // back to whichever tab actually has a dialog open.
        const any = anyPendingDialog();
        if (any) { tabId = any.tabId; pending = any; }
      }
      if (!pending) {
        return { note: 'No browser dialog is currently open, so there is nothing to handle.' };
      }
      const accept = Boolean(args.accept);
      const promptText = pending.type === 'prompt' && accept
        ? String(args.text ?? pending.defaultPrompt ?? '')
        : undefined;
      await handleDialog(tabId, accept, promptText);
      return {
        handled: pending.type,
        accepted: accept,
        message: pending.message,
        enteredText: promptText,
        note: PAGE_CHANGE_NOTE
      };
    }
    case 'where_am_i':
      return pageCall({ action: 'where_am_i' });
    case 'navigate': {
      const tab = await activeTab({ requirePageAccess: false });
      if (args.action === 'url') {
        let url = String(args.url || '').trim();
        if (!url) throw new Error('url is required when action is "url".');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        await chrome.tabs.update(tab.id, { url });
        return { navigatedTo: url, note: PAGE_CHANGE_NOTE };
      }
      if (args.action === 'back') { await chrome.tabs.goBack(tab.id); }
      else if (args.action === 'forward') { await chrome.tabs.goForward(tab.id); }
      else if (args.action === 'reload') { await chrome.tabs.reload(tab.id); }
      else throw new Error('Unknown navigate action: ' + args.action);
      return { done: args.action, note: PAGE_CHANGE_NOTE };
    }
    case 'get_user_profile': {
      const { profile } = await chrome.storage.local.get('profile');
      if (!profile || !Object.values(profile).some(v => v)) {
        return {
          empty: true,
          note: 'No profile saved. Tell the user they can save their details on the Trish options page, or ask them to dictate the values.'
        };
      }
      return profile;
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}
