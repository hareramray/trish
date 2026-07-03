// Trish content script: builds compact page snapshots for the model and
// executes actions (click, fill, scroll...) against live DOM nodes.
(() => {
  if (window.__trishInjected) return;
  window.__trishInjected = true;

  const MAX_ELEMENTS = 200;
  const MAX_NAME_LEN = 80;
  const READ_CHUNK = 6000;

  // element_id ("e1", "e2"...) -> live node, rebuilt on every snapshot
  let elementMap = new Map();
  let idCounter = 0;

  // ---------- visibility & naming ----------

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function truncate(s, n = MAX_NAME_LEN) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // Simplified accessible-name computation, in ARIA priority order.
  function accName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (text.trim()) return truncate(text);
    }
    if (el.getAttribute('aria-label')) return truncate(el.getAttribute('aria-label'));
    if (el.labels && el.labels.length) return truncate(el.labels[0].textContent);
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return truncate(lbl.textContent);
    }
    const wrapLabel = el.closest('label');
    if (wrapLabel) return truncate(wrapLabel.textContent);
    if (el.placeholder) return truncate(el.placeholder);
    if (el.alt) return truncate(el.alt);
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button') && el.value) {
      return truncate(el.value);
    }
    if (el.title) return truncate(el.title);
    const text = el.textContent;
    if (text && text.trim()) return truncate(text);
    if (el.tagName === 'A' && el.href) return truncate(el.href);
    return '';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      return t; // text, email, password, search, number, date, tel, file...
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  // ---------- snapshot builders ----------

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    'summary', '[contenteditable="true"]', '[onclick]',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="switch"]',
    '[role="option"]', '[role="textbox"]'
  ].join(',');

  // Walk every element in the document, descending into open shadow roots so
  // web-component widgets (cookie/consent banners, many modern site popups)
  // are visible. Closed shadow roots stay opaque — those need look_at_page +
  // click_at_coordinates. Shadow elements share the host's coordinate space,
  // so getBoundingClientRect (and trusted clicks) work unchanged.
  function* deepElements(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      yield node;
      if (node.shadowRoot) yield* deepElements(node.shadowRoot);
      node = walker.nextNode();
    }
  }

  function deepQueryAll(selector, root = document) {
    const out = [];
    for (const el of deepElements(root)) {
      if (el.matches?.(selector)) out.push(el);
    }
    return out;
  }

  function collectInteractive() {
    elementMap = new Map();
    idCounter = 0;
    const seen = new Set();
    const nodes = deepQueryAll(INTERACTIVE_SELECTOR)
      .filter(el => !seen.has(el) && seen.add(el) && isVisible(el));

    // Prefer in-viewport elements when the page has more than we can send.
    nodes.sort((a, b) => Number(inViewport(b)) - Number(inViewport(a)));

    const out = [];
    for (const el of nodes.slice(0, MAX_ELEMENTS)) {
      const id = 'e' + (++idCounter);
      elementMap.set(id, el);
      const role = roleOf(el);
      const entry = { id, role, name: accName(el) };
      if (!inViewport(el)) entry.offscreen = true;
      if (el.disabled) entry.disabled = true;
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        entry.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      } else if (role === 'select') {
        entry.value = truncate(el.selectedOptions[0]?.textContent || '', 60);
      } else if (role === 'password') {
        entry.value = el.value ? '(hidden)' : '(empty)';
      } else if ('value' in el && typeof el.value === 'string' && el.value &&
                 el.tagName !== 'BUTTON') {
        entry.value = truncate(el.value, 60);
      }
      if (el.required) entry.required = true;
      out.push(entry);
    }
    return out;
  }

  function mainContentRoot() {
    return document.querySelector('main, [role="main"], article') || document.body;
  }

  // Non-text and structural-noise tags we never read.
  const READ_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS'
  ]);
  const READ_NOISE_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);

  // Walk the flattened (composed) tree so text inside open shadow roots and
  // slotted content is included — plain innerText/cloneNode both stop at the
  // shadow boundary and miss web-component content (many site popups, cards,
  // and design-system widgets). We read live computed styles to place line
  // breaks at block boundaries, and never mutate the page.
  function collectReadable(node, parts) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (READ_SKIP_TAGS.has(tag)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    const role = el.getAttribute('role');
    if (READ_NOISE_TAGS.has(tag) || role === 'navigation' || role === 'banner') return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;

    if (tag === 'BR') { parts.push('\n'); return; }

    const d = style.display;
    const block = d === 'block' || d === 'flex' || d === 'grid' || d === 'flow-root' ||
      d === 'list-item' || d.startsWith('table');
    if (block) parts.push('\n');

    if (tag === 'SLOT') {
      for (const n of el.assignedNodes({ flatten: true })) collectReadable(n, parts);
    } else if (el.shadowRoot) {
      // Shadow host: its rendered content is the shadow tree (light children
      // only appear via <slot>, handled above), so read the shadow root.
      for (const n of el.shadowRoot.childNodes) collectReadable(n, parts);
    } else {
      for (const n of el.childNodes) collectReadable(n, parts);
    }

    if (block) parts.push('\n');
  }

  function readableText() {
    const parts = [];
    collectReadable(mainContentRoot(), parts);
    return parts.join('')
      .replace(/[^\S\n]+/g, ' ')   // collapse spaces/tabs, keep newlines
      .replace(/ *\n */g, '\n')    // trim spaces hugging newlines
      .replace(/\n{3,}/g, '\n\n')  // cap blank-line runs
      .trim();
  }

  function headingList() {
    return [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter(isVisible)
      .slice(0, 40)
      .map(h => ({ level: Number(h.tagName[1]), text: truncate(h.textContent) }));
  }

  function landmarkList() {
    const found = [];
    const pairs = [
      ['main, [role="main"]', 'main content'],
      ['nav, [role="navigation"]', 'navigation'],
      ['[role="search"]', 'search'],
      ['header, [role="banner"]', 'header'],
      ['footer, [role="contentinfo"]', 'footer'],
      ['aside, [role="complementary"]', 'sidebar']
    ];
    for (const [sel, label] of pairs) {
      if (document.querySelector(sel)) found.push(label);
    }
    return found;
  }

  function overview() {
    const text = readableText();
    return {
      title: document.title,
      url: location.href,
      language: document.documentElement.lang || undefined,
      headings: headingList(),
      landmarks: landmarkList(),
      counts: {
        links: document.querySelectorAll('a[href]').length,
        buttons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
        forms: document.forms.length,
        images: document.images.length
      },
      contentPreview: truncate(text, 1500),
      contentLength: text.length
    };
  }

  function readContent(offset = 0) {
    const text = readableText();
    const chunk = text.slice(offset, offset + READ_CHUNK);
    const nextOffset = offset + chunk.length;
    return {
      text: chunk,
      totalLength: text.length,
      nextOffset: nextOffset < text.length ? nextOffset : null,
      note: nextOffset < text.length
        ? 'More content remains. Call read_page_content with offset=' + nextOffset + ' to continue.'
        : 'End of content.'
    };
  }

  function formFields() {
    // Refresh the element map so returned ids are actionable.
    const elements = collectInteractive();
    const fieldRoles = new Set([
      'text', 'email', 'password', 'search', 'number', 'tel', 'url', 'date',
      'textbox', 'select', 'checkbox', 'radio', 'combobox', 'file'
    ]);
    const fields = elements.filter(e => fieldRoles.has(e.role));
    for (const f of fields) {
      const el = elementMap.get(f.id);
      if (el && el.tagName === 'SELECT') {
        f.options = [...el.options].slice(0, 30).map(o => truncate(o.textContent, 60));
      }
    }
    return { formCount: document.forms.length, fields };
  }

  // ---------- actions ----------

  function getEl(id) {
    const el = elementMap.get(id);
    if (!el || !el.isConnected) {
      throw new Error(
        `Element ${id} not found or no longer on the page. ` +
        'Call list_interactive_elements or get_form_fields to get fresh element ids.'
      );
    }
    return el;
  }

  function doClick(id) {
    const el = getEl(id);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    el.click();
    return { clicked: accName(el) || el.tagName.toLowerCase() };
  }

  // React/Vue ignore plain `.value =` assignments; go through the native
  // setter and fire input/change so framework state updates.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function doFill(id, value) {
    const el = getEl(id);
    if (el.type === 'password') {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      throw new Error(
        'For security, Trish does not fill password fields. The field is now ' +
        'focused; ask the user to type their password on the keyboard.'
      );
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.tagName === 'SELECT') return doSelect(id, value);
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { filled: accName(el), value };
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      throw new Error('Use set_checkbox for checkboxes and radio buttons.');
    }
    setNativeValue(el, value);
    return { filled: accName(el) || el.name || id, value: el.value };
  }

  function doSelect(id, option) {
    const el = getEl(id);
    if (el.tagName !== 'SELECT') throw new Error(`Element ${id} is not a dropdown.`);
    const wanted = option.toLowerCase();
    const match =
      [...el.options].find(o => o.textContent.trim().toLowerCase() === wanted) ||
      [...el.options].find(o => o.textContent.toLowerCase().includes(wanted)) ||
      [...el.options].find(o => o.value.toLowerCase() === wanted);
    if (!match) {
      throw new Error(
        `No option matching "${option}". Available: ` +
        [...el.options].slice(0, 30).map(o => o.textContent.trim()).join(' | ')
      );
    }
    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: match.textContent.trim(), in: accName(el) };
  }

  function doSetCheckbox(id, checked) {
    const el = getEl(id);
    const isCheckable = el.type === 'checkbox' || el.type === 'radio' ||
      ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role'));
    if (!isCheckable) throw new Error(`Element ${id} is not a checkbox, radio, or switch.`);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const current = el.checked ?? (el.getAttribute('aria-checked') === 'true');
    if (current !== checked) el.click();
    return { element: accName(el), checked };
  }

  function doPressEnter(id) {
    const el = getEl(id);
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    }
    // Real Enter submits the surrounding form; synthetic events don't.
    if (el.form && typeof el.form.requestSubmit === 'function') {
      el.form.requestSubmit();
    }
    return { pressedEnterOn: accName(el) || id };
  }

  function doScroll(direction) {
    const page = () => Math.round(innerHeight * 0.8);
    switch (direction) {
      case 'up': scrollBy({ top: -page(), behavior: 'instant' }); break;
      case 'down': scrollBy({ top: page(), behavior: 'instant' }); break;
      case 'top': scrollTo({ top: 0, behavior: 'instant' }); break;
      case 'bottom': scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }); break;
      default: throw new Error('direction must be up, down, top, or bottom');
    }
    const max = Math.max(1, document.body.scrollHeight - innerHeight);
    return { scrolledTo: Math.round((scrollY / max) * 100) + '% of page' };
  }

  // Center coordinates for a trusted CDP click, in viewport CSS pixels.
  function elementRect(id) {
    const el = getEl(id);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    return { x: Math.round(x), y: Math.round(y), name: accName(el) };
  }

  // Focus an element so trusted typing lands in it. Reports password fields
  // so the caller can refuse to type into them.
  function focusForTyping(id) {
    const el = getEl(id);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    return {
      name: accName(el),
      isPassword: el.type === 'password',
      focused: document.activeElement === el
    };
  }

  function whereAmI() {
    const active = document.activeElement;
    const max = Math.max(1, document.body.scrollHeight - innerHeight);
    return {
      title: document.title,
      url: location.href,
      scrollPosition: Math.round((scrollY / max) * 100) + '%',
      focusedElement: active && active !== document.body
        ? { role: roleOf(active), name: accName(active) }
        : null
    };
  }

  // ---------- live region announcements ----------

  const recentAnnouncements = new Map(); // text -> timestamp, for dedupe
  let announceTimer = null;
  let pendingAnnouncements = [];

  function flushAnnouncements() {
    announceTimer = null;
    const texts = pendingAnnouncements;
    pendingAnnouncements = [];
    for (const text of texts) {
      chrome.runtime.sendMessage({ type: 'TRISH_LIVE_REGION', text }).catch(() => {});
    }
  }

  function queueAnnouncement(text) {
    text = truncate(text, 300);
    if (!text) return;
    const now = Date.now();
    if (now - (recentAnnouncements.get(text) || 0) < 5000) return;
    recentAnnouncements.set(text, now);
    pendingAnnouncements.push(text);
    if (!announceTimer) announceTimer = setTimeout(flushAnnouncements, 500);
  }

  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const alertEl = node.matches?.('[role="alert"], [aria-live="assertive"]')
          ? node
          : node.querySelector?.('[role="alert"], [aria-live="assertive"]');
        const container = node.closest?.('[role="alert"], [aria-live="assertive"]');
        const target = alertEl || container;
        if (target) queueAnnouncement(target.textContent);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- message dispatch ----------

  const handlers = {
    overview: () => overview(),
    elements: (msg) => {
      let list = collectInteractive();
      if (msg.filter) {
        const f = msg.filter.toLowerCase();
        list = list.filter(e => e.name.toLowerCase().includes(f) || e.role.includes(f));
      }
      return { count: list.length, elements: list };
    },
    read: (msg) => readContent(msg.offset || 0),
    form_fields: () => formFields(),
    click: (msg) => doClick(msg.element_id),
    fill: (msg) => doFill(msg.element_id, String(msg.value ?? '')),
    select_option: (msg) => doSelect(msg.element_id, String(msg.option ?? '')),
    set_checkbox: (msg) => doSetCheckbox(msg.element_id, Boolean(msg.checked)),
    press_enter: (msg) => doPressEnter(msg.element_id),
    rect: (msg) => elementRect(msg.element_id),
    focus_el: (msg) => focusForTyping(msg.element_id),
    scroll: (msg) => doScroll(msg.direction),
    where_am_i: () => whereAmI(),
    ping: () => ({ pong: true })
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'TRISH_PAGE') return;
    try {
      const handler = handlers[msg.action];
      if (!handler) throw new Error('Unknown action: ' + msg.action);
      sendResponse({ ok: true, data: handler(msg) });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  });
})();
