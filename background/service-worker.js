// Thin background worker: opens the side panel and relays keyboard commands.
// All heavy lifting (audio, model session, tool routing) lives in the side
// panel, which persists across tab switches.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  const win = await chrome.windows.getLastFocused();
  if (command === 'open-panel') {
    await chrome.sidePanel.open({ windowId: win.id });
  } else if (command === 'toggle-voice') {
    await chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
    // Panel may still be loading; retry briefly until its listener answers.
    for (let i = 0; i < 5; i++) {
      try {
        await chrome.runtime.sendMessage({ type: 'TRISH_TOGGLE_VOICE' });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }
});
