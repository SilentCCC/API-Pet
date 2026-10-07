const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('apiPet', {
  detectProviderCurrency: provider => ipcRenderer.invoke('detect-provider-currency', provider),
  setChatFormat: format => ipcRenderer.invoke('set-chat-format', format),
  moveProvider: data => ipcRenderer.invoke('move-provider', data),
  generateImages: data => ipcRenderer.invoke('generate-images', data),
  saveGeneratedImage: url => ipcRenderer.invoke('save-generated-image', url),
  showGeneratedImageMenu: url => ipcRenderer.invoke('show-generated-image-menu', url),
  showInlineImageMenu: image => ipcRenderer.invoke('show-inline-image-menu', image),
  resizePanelHeight: height => ipcRenderer.invoke('resize-panel-height', height),
  onPanelHeight: fn => ipcRenderer.on('panel-height', (_e, height) => fn(height)),
  resizePanelWidth: width => ipcRenderer.invoke('resize-panel-width', width),
  onPanelWidth: fn => ipcRenderer.on('panel-width', (_e, width) => fn(width)),
  getState: () => ipcRenderer.invoke('get-state'), openProviderLogin: url => ipcRenderer.invoke('open-provider-login', url), chatRequest: data => ipcRenderer.invoke('chat-request', data), getChatModels: data => ipcRenderer.invoke('get-chat-models', data), getBalanceActivity: () => ipcRenderer.invoke('get-balance-activity'), saveProvider: data => ipcRenderer.invoke('save-provider', data), connectProviderAccount: data => ipcRenderer.invoke('connect-provider-account', data), importProviderTokens: input => ipcRenderer.invoke('import-provider-tokens', input), deleteProvider: id => ipcRenderer.invoke('delete-provider', id), testProvider: id => ipcRenderer.invoke('test-provider', id), refreshProviderBalance: id => ipcRenderer.invoke('refresh-provider-balance', id), refreshAllBalances: () => ipcRenderer.invoke('refresh-all-balances'), setBalanceSettings: settings => ipcRenderer.invoke('set-balance-settings', settings), setRoute: data => ipcRenderer.invoke('set-route', data), setRoutingMode: mode => ipcRenderer.invoke('set-routing-mode', mode), setRoutingEnabled: enabled => ipcRenderer.invoke('set-routing-enabled', enabled), setUnifiedRoute: data => ipcRenderer.invoke('set-unified-route', data), setPanelOpen: open => ipcRenderer.invoke('set-panel-open', open), quit: () => ipcRenderer.invoke('quit'), onBalanceActivity: fn => ipcRenderer.on('balance-activity', (_e, active) => fn(active)), onGatewayStatus: fn => ipcRenderer.on('gateway-status', (_e, data) => fn(data)), onShowPanel: fn => ipcRenderer.on('show-panel', fn)
});
