const SETTING_IDS = [
  'provider', 'geminiKey', 'openaiKey',
  'geminiModel', 'geminiVisionModel', 'geminiVoice',
  'model', 'visionModel', 'voice', 'language'
];
const PROFILE_IDS = ['fullName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode', 'country'];

const DEFAULTS = {
  provider: 'gemini',
  geminiModel: 'gemini-3.1-flash-live-preview',
  geminiVisionModel: 'gemini-2.5-pro',
  geminiVoice: 'Puck',
  model: 'gpt-realtime',
  visionModel: 'gpt-5',
  voice: 'marin'
};

async function load() {
  const { settings = {}, profile = {} } = await chrome.storage.local.get(['settings', 'profile']);
  for (const id of SETTING_IDS) {
    document.getElementById(id).value = settings[id] ?? DEFAULTS[id] ?? '';
  }
  for (const id of PROFILE_IDS) {
    document.getElementById(id).value = profile[id] ?? '';
  }
}

async function save() {
  const settings = {};
  for (const id of SETTING_IDS) {
    const value = document.getElementById(id).value.trim();
    settings[id] = value || DEFAULTS[id] || '';
  }
  const profile = {};
  for (const id of PROFILE_IDS) profile[id] = document.getElementById(id).value.trim();
  await chrome.storage.local.set({ settings, profile });
  const status = document.getElementById('save-status');
  status.textContent = 'Saved.';
  setTimeout(() => { status.textContent = ''; }, 3000);
}

document.getElementById('save').addEventListener('click', save);
load();
