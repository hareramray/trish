const status = document.getElementById('status');
const btn = document.getElementById('enable');

async function requestMic() {
  status.className = '';
  status.textContent = 'Requesting microphone… look for the Allow prompt near the address bar.';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    status.className = 'ok';
    status.textContent =
      'Microphone enabled! You can close this tab, go back to the Trish side ' +
      'panel, and press "Start voice session".';
    btn.textContent = 'Microphone enabled';
    btn.disabled = true;
  } catch (err) {
    status.className = 'err';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      status.textContent =
        'Access was blocked. Click the lock/tune icon in the address bar, set ' +
        'Microphone to Allow, then press the button again.';
    } else if (err.name === 'NotFoundError') {
      status.textContent = 'No microphone was found on this computer. Connect one and try again.';
    } else {
      status.textContent = 'Error: ' + err.message;
    }
  }
}

btn.addEventListener('click', requestMic);
// Try immediately too — if permission was already granted this just confirms.
requestMic();
