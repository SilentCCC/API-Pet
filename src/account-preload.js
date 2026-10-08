const { ipcRenderer } = require('electron');

// Run before the site's scripts. Only replace the browser refresh credential
// when it is the exact one last observed by API Pet, so a newer browser login
// is never overwritten by an older saved provider snapshot.
try {
  if (window.top === window) {
    const credentials = ipcRenderer.sendSync('account-session-bootstrap', localStorage.getItem('refresh_token') || '');
    if (credentials?.token) localStorage.setItem('auth_token', credentials.token);
    if (credentials?.refreshToken) localStorage.setItem('refresh_token', credentials.refreshToken);
  }
} catch {}
