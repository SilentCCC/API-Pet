const $ = id => document.getElementById(id);
let appState;
let editingId = null;
let connectingAccounts = 0;
let refreshingAllAccounts = false;
let providerTestsActive = 0;
let manualBalanceQueries = 0;
let balanceQueryActive = false;
let balanceAnimationHoldUntil = 0;
let connectionAnimationPlayed = false;
let balanceAnimationPlayed = false;
let animationTimer;
let toastTimer;
let currentPetAnimation = 'pet-normal.webp';
const PET_ANIMATION_DURATION = 5160;
const petImage = document.querySelector('.pet-image');
let chatSiteSelection = localStorage.getItem('api-pet-chat-site') || '';
let chatModelSelection = localStorage.getItem('api-pet-chat-model') || '';
let chatKeySelection = '';
let chatFetchedModels = [];
let chatFetchedProviderId = '';
let chatFetchedKeyIndex = -1;
let chatModelFetchToken = 0;
let chatModelsLoading = false;
let chatImages = [];
let chatImagesLoading = 0;
let chatSending = false;
let chatImageQueue = Promise.resolve();
const CHAT_IMAGE_LIMIT = 4;
const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
let drawingOptions = { resolution: '1K', ratio: '1:1', width: 1024, height: 1024, quality: 'high', count: 1,
  responseFormat: 'b64_json', editEndpoint: 'auto', watermark: true, promptExtend: true, outputFormat: 'png' };
let providersCollapsed = localStorage.getItem('api-pet-providers-collapsed') === 'true';
let collapsedProviderIds = new Set(JSON.parse(localStorage.getItem('api-pet-collapsed-provider-ids') || '[]'));
let expandedProviderIds = new Set(JSON.parse(localStorage.getItem('api-pet-expanded-provider-ids') || '[]'));
let providerTokenRows = [];
let providerDrag = null;
let providerOrderSaving = false;
let draftAccountData = null;
const panel = $('panel');
const chatPanel = $('chatPanel');
const dialog = $('providerDialog');
const appRoot = document.querySelector('.app');
let panelHeight = 430;
let panelWidth = 450;
function setupPanelWidthResize() {
  window.apiPet.onPanelWidth(width => {
    panelWidth = width;
    panel.style.width = `${width}px`;
  });
  const handle = document.createElement('div');
  handle.className = 'panel-width-handle';
  handle.title = '调节控制面板宽度（400–500 像素）';
  let drag = null;
  let pendingWidth = null;
  let sending = false;
  async function flushResize() {
    if (sending) return;
    sending = true;
    try {
      while (pendingWidth != null) {
        const width = pendingWidth;
        pendingWidth = null;
        await window.apiPet.resizePanelWidth(width);
      }
    } catch (error) {
      pendingWidth = null;
      toast(`调整宽度失败：${error?.message || error}`);
    } finally { sending = false; }
  }
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, x: event.screenX, width: panelWidth };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('resizing');
    appRoot.classList.add('resizing-panel-width');
  };
  handle.onpointermove = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    pendingWidth = Math.min(500, Math.max(400, drag.width + event.screenX - drag.x));
    flushResize();
  };
  const finish = () => {
    drag = null;
    handle.classList.remove('resizing');
    appRoot.classList.remove('resizing-panel-width');
  };
  handle.onpointerup = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    handle.releasePointerCapture(event.pointerId);
    finish();
  };
  handle.onpointercancel = finish;
  handle.onlostpointercapture = finish;
  panel.prepend(handle);
}
function setupPanelHeightResize() {
  window.apiPet.onPanelHeight(height => {
    panelHeight = height;
    appRoot.style.setProperty('--panel-height', `${height}px`);
  });
  [panel, chatPanel].forEach(surface => {
    const handle = document.createElement('div');
    handle.className = 'panel-height-handle';
    handle.title = '调节窗口高度';
    let drag = null;
    let pendingHeight = null;
    let sending = false;
    async function flushResize() {
      if (sending) return;
      sending = true;
      try {
        while (pendingHeight != null) {
          const height = pendingHeight;
          pendingHeight = null;
          await window.apiPet.resizePanelHeight(height);
        }
      } catch (error) {
        pendingHeight = null;
        toast(`调整高度失败：${error?.message || error}`);
      } finally { sending = false; }
    }
    handle.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { pointerId: event.pointerId, y: event.screenY, height: panelHeight };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('resizing');
      appRoot.classList.add('resizing-panel');
    };
    handle.onpointermove = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      pendingHeight = drag.height + drag.y - event.screenY;
      flushResize();
    };
    const finish = () => {
      drag = null;
      handle.classList.remove('resizing');
      appRoot.classList.remove('resizing-panel');
    };
    handle.onpointerup = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      handle.releasePointerCapture(event.pointerId);
      finish();
    };
    handle.onpointercancel = finish;
    handle.onlostpointercapture = finish;
    surface.prepend(handle);
  });
}

function updatePetAnimation() {
  if (!petImage) return;
  if (connectingAccounts > 0 || providerTestsActive > 0) {
    if (!connectionAnimationPlayed) {
      connectionAnimationPlayed = true;
      playPetAnimationOnce('pet-working.webp');
    }
    return;
  }
  if (balanceQueryActive) {
    if (!balanceAnimationPlayed) {
      balanceAnimationPlayed = true;
      playPetAnimationOnce('pet-eating.webp');
    }
    return;
  }
  clearTimeout(animationTimer);
  if (currentPetAnimation !== 'pet-normal.webp') {
    currentPetAnimation = 'pet-normal.webp';
    petImage.dataset.animation = currentPetAnimation;
    petImage.src = `assets/${currentPetAnimation}`;
  }
}
function playPetAnimationOnce(animation) {
  clearTimeout(animationTimer);
  currentPetAnimation = animation;
  petImage.dataset.animation = animation;
  petImage.src = `assets/${animation}`;
  animationTimer = setTimeout(() => {
    if (currentPetAnimation !== animation) return;
    if (connectingAccounts > 0 || providerTestsActive > 0 || balanceQueryActive) return;
    currentPetAnimation = 'pet-normal.webp';
    petImage.dataset.animation = currentPetAnimation;
    petImage.src = `assets/${currentPetAnimation}`;
  }, PET_ANIMATION_DURATION);
}
function setBalanceActivity(active) {
  const next = active === true;
  if (next && !balanceQueryActive) balanceAnimationPlayed = false;
  if (!next && manualBalanceQueries === 0) balanceAnimationPlayed = false;
  balanceQueryActive = next || manualBalanceQueries > 0;
  updatePetAnimation();
}

function beginManualBalanceQuery() {
  if (manualBalanceQueries === 0) {
    balanceAnimationPlayed = false;
    balanceAnimationHoldUntil = Date.now() + PET_ANIMATION_DURATION;
  }
  manualBalanceQueries += 1;
  balanceQueryActive = true;
  updatePetAnimation();
}

function endManualBalanceQuery() {
  manualBalanceQueries = Math.max(0, manualBalanceQueries - 1);
  if (manualBalanceQueries === 0) balanceQueryActive = false;
  if (manualBalanceQueries === 0 && !balanceQueryActive) {
    const remaining = Math.max(0, balanceAnimationHoldUntil - Date.now());
    if (remaining > 0) {
      clearTimeout(animationTimer);
      animationTimer = setTimeout(() => {
        if (manualBalanceQueries === 0 && !balanceQueryActive) updatePetAnimation();
      }, remaining);
      return;
    }
  }
  updatePetAnimation();
}

async function setPanelVisible(visible) {
  appRoot.classList.toggle('panel-open', visible);
  const synced = await window.apiPet.setPanelOpen(visible);
  panel.classList.toggle('hidden', !visible);
  if (visible) updateCompactMoneyColumns();
  chatPanel.classList.add('hidden');
  if (!synced) appRoot.classList.toggle('panel-open', visible);
}

async function setChatVisible(visible) {
  appRoot.classList.toggle('panel-open', visible);
  const synced = await window.apiPet.setPanelOpen(visible);
  chatPanel.classList.toggle('hidden', !visible);
  panel.classList.add('hidden');
  if (!synced) appRoot.classList.toggle('panel-open', visible);
  if (visible) {
    updateChatModelLabel();
    setTimeout(() => $('chatInput')?.focus(), 0);
  }
}

function toast(message) {
  const el = dialog?.open ? $('dialogToast') : $('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = message;
  el.classList.add('show');
  const text = String(message || '');
  const isError = /失败|错误|异常|unauthorized|not found|invalid|timeout|超时/i.test(text);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 12000 : 5000);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function statusLabel(provider) {
  return provider.status === 'online' ? '🟢 连接正常' : provider.status === 'error' ? '🔴 连接失败' : '🟡 未测试';
}
function formatCompactMoney(value, currency) {
  const amount = value != null && String(value).trim() !== '' && Number.isFinite(Number(value))
    ? Number(value).toFixed(4)
    : '-.----';
  return `${currency || '$'}${amount}`;
}
function balanceLabel(provider) {
  const status = provider.balance?.status;
  return status === 'online' ? '余额正常' : status === 'low' ? '余额较低' : status === 'empty' ? '无余额' : status === 'error' ? '查询失败' : status === 'unconfigured' ? '未配置余额接口' : '未查询';
}
function updatePetBalanceStatus() {
  const el = $('petStatus');
  if (!el) return;
  const balances = appState.providers.map(provider => provider.balance || {});
  const hasError = balances.some(balance => balance.status === 'error');
  const hasEmpty = balances.some(balance => balance.status === 'empty');
  const hasLow = balances.some(balance => balance.status === 'low');
  if (hasError) el.textContent = '💦 API 联系不上了';
  else if (hasEmpty) el.textContent = '🔴 没钱啦';
  else if (hasLow) el.textContent = '🟡 API 快没钱啦';
  else if (!el.textContent.startsWith('⚡') && !el.textContent.startsWith('✨')) el.textContent = '🟢 网关运行中';
}
function ensureProviderToggle() {
  if ($('toggleProviders')) return;
  const title = $('providers')?.previousElementSibling;
  const addButton = $('addProvider');
  if (!title || !addButton) return;
  const actions = document.createElement('div');
  actions.className = 'provider-heading-actions';
  const toggle = document.createElement('button');
  toggle.id = 'toggleProviders';
  toggle.type = 'button';
  toggle.className = 'ghost small';
  toggle.onclick = () => {
    const allCollapsed = providersCollapsed || (appState.providers.length > 0 && appState.providers.every(provider => collapsedProviderIds.has(provider.id)));
    providersCollapsed = !allCollapsed;
    if (!providersCollapsed) {
      collapsedProviderIds.clear();
      expandedProviderIds.clear();
    } else {
      expandedProviderIds.clear();
    }
    localStorage.setItem('api-pet-providers-collapsed', String(providersCollapsed));
    localStorage.setItem('api-pet-collapsed-provider-ids', JSON.stringify([...collapsedProviderIds]));
    localStorage.setItem('api-pet-expanded-provider-ids', JSON.stringify([...expandedProviderIds]));
    render();
  };
  const refreshAccounts = document.createElement('button');
  refreshAccounts.id = 'refreshAllAccounts';
  refreshAccounts.type = 'button';
  refreshAccounts.className = 'ghost small';
  refreshAccounts.textContent = '一键刷新账户';
  refreshAccounts.onclick = refreshAllProviderAccounts;
  actions.append(refreshAccounts, toggle, addButton);
  title.appendChild(actions);
}
function moveGatewayIntoRouting() {
  const routes = $('routes');
  const routingTitle = [...document.querySelectorAll('.section-title')].find(item => item.querySelector('span')?.textContent.trim() === '路由设置');
  const gateway = $('localGateway');
  const controls = $('routingEnabled')?.closest('.routing-controls');
  if (!routes || !routingTitle || !gateway || !controls) return;
  let wrapper = $('routingGateway');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'routingGateway';
    controls.after(wrapper);
  }
  wrapper.append(gateway);
}
async function copyGatewayValue(id, label) {
  try {
    await navigator.clipboard.writeText($(id).textContent);
    toast(`${label} 已复制`);
  } catch (error) {
    toast(`复制失败：${error?.message || error}`);
  }
}
function render() {
  if (providerDrag?.dragging) return;
  providerDrag?.cancel();
  $('unifiedKey').textContent = appState.unifiedKey;
  $('lowThreshold').value = appState.balanceSettings?.lowThreshold ?? 5;
  $('refreshMinutes').value = appState.balanceSettings?.refreshMinutes ?? 10;
  const allProvidersCollapsed = providersCollapsed || (appState.providers.length > 0 && appState.providers.every(provider => collapsedProviderIds.has(provider.id)));
  $('refreshAllAccounts').disabled = refreshingAllAccounts || appState.providers.every(provider => !['sub2api', 'new-api', 'aihub'].includes(provider.balanceAdapter));
  $('toggleProviders').textContent = allProvidersCollapsed ? '展开全部' : '折叠全部';
  $('toggleProviders').setAttribute('aria-expanded', String(!allProvidersCollapsed));
  const list = $('providers');
  list.innerHTML = '';
  appState.providers.forEach((provider, index) => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.providerId = provider.id;
    const balance = provider.balance || {};
    const skipBalance = provider.balanceAdapter === 'none';
    const amount = skipBalance ? '不查询' : balance.balance == null ? '--' : `${escapeHtml(provider.currency || balance.currency || '$')}${Number(balance.balance).toFixed(4)}`;
    const remaining = balance.remaining == null ? '--' : Number(balance.remaining).toFixed(2);
    const checked = balance.updatedAt ? new Date(balance.updatedAt).toLocaleString() : '尚未查询';
    const stats = provider.dailyStats || {};
    const accountStats = skipBalance ? {} : provider.accountStats || {};
    const hasAccountStats = Number.isFinite(Number(accountStats.todayCost)) && Number.isFinite(Number(accountStats.todayRequests));
    const localRequests = Number(stats.requestCount) || 0;
    const requests = hasAccountStats ? Number(accountStats.todayRequests) : localRequests;
    const successRate = localRequests ? `${((Number(stats.successCount) || 0) / localRequests * 100).toFixed(1)}%` : '--';
    const todayTokens = accountStats.todayTokens != null && Number.isFinite(Number(accountStats.todayTokens)) ? Number(accountStats.todayTokens).toLocaleString() : '--';
    const averageResponseMs = accountStats.averageDurationMs != null ? Number(accountStats.averageDurationMs) : NaN;
    const averageResponse = Number.isFinite(averageResponseMs) ? `${(averageResponseMs / 1000).toFixed(2)} 秒` : '--';
    const consumption = hasAccountStats ? `${escapeHtml(provider.currency || balance.currency || '$')}${Number(accountStats.todayCost).toFixed(4)}` : Number.isFinite(Number(stats.cost)) ? `${escapeHtml(stats.costCurrency || provider.currency || '$')}${Number(stats.cost).toFixed(4)}` : Number(stats.usageTokens) > 0 ? `${Number(stats.usageTokens).toLocaleString()} tokens` : '--';
    const connectButton = ['sub2api', 'new-api', 'aihub'].includes(provider.balanceAdapter) ? '<button class="connect-account">连接账户</button>' : '';
    const displayUrl = provider.requestUrl || provider.loginUrl || provider.baseUrl || '';
  const balanceConnection = balance.apiStatus === 'online' ? '🟢 连接正常' : balance.apiStatus === 'error' ? '🔴 连接失败' : '🟡 未测试';
  const connectionIcon = provider.status === 'online' ? '🟢' : provider.status === 'error' ? '🔴' : '🟡';
  const compact = providersCollapsed
    ? !expandedProviderIds.has(provider.id)
    : collapsedProviderIds.has(provider.id);
  if (compact) {
    card.classList.add('provider-card-compact');
    if (providersCollapsed) setupProviderDragSort(card);
    const compactConsumption = formatCompactMoney(skipBalance ? null : hasAccountStats ? accountStats.todayCost : stats.cost, hasAccountStats ? provider.currency || balance.currency : stats.costCurrency || provider.currency);
    const compactBalance = formatCompactMoney(skipBalance ? null : balance.balance, provider.currency || balance.currency);
    const reorder = providersCollapsed ? `<div class="provider-reorder-actions">${index > 0 ? '<button class="provider-reorder" data-direction="up" type="button" aria-label="上移站点" title="上移站点">↑</button>' : '<span></span>'}${index < appState.providers.length - 1 ? '<button class="provider-reorder" data-direction="down" type="button" aria-label="下移站点" title="下移站点">↓</button>' : '<span></span>'}</div>` : '';
    card.innerHTML = `<div class="provider-compact-name" title="${escapeHtml(provider.name)}">${escapeHtml(provider.name)}</div><b class="provider-compact-consumption" title="今日消耗：${escapeHtml(compactConsumption)}">${escapeHtml(compactConsumption)}</b><span class="provider-compact-models" title="${provider.models?.length || 0}个模型">${provider.models?.length || 0}个模型</span><b class="provider-compact-balance" title="余额：${escapeHtml(compactBalance)}">${escapeHtml(compactBalance)}</b><span class="provider-compact-status" title="${statusLabel(provider)}" aria-label="${statusLabel(provider)}">${connectionIcon}</span><div class="provider-compact-actions">${reorder}<button class="provider-toggle compact-toggle" type="button" aria-label="展开 ${escapeHtml(provider.name)}">⌄</button></div>`;
  } else {
    card.innerHTML = `<div class="provider-top"><div><div class="provider-name">${escapeHtml(provider.name)}</div><div class="provider-url">请求：${escapeHtml(displayUrl)}${provider.loginUrl && provider.loginUrl !== displayUrl ? `<br>登录：${escapeHtml(provider.loginUrl)}` : ''}</div></div><div class="provider-top-actions"><span class="badge ${provider.status}">${statusLabel(provider)} · ${provider.models?.length || 0} 个模型</span><button class="provider-toggle" type="button" aria-label="折叠 ${escapeHtml(provider.name)}">⌃</button></div></div>${skipBalance ? '' : `<div class="balance-line"><b>${amount}</b><span>${balanceLabel(provider)}</span></div><div class="balance-meta">剩余额度：${remaining}　查询：${escapeHtml(checked)}<br>余额接口：${balanceConnection}</div>`}<div class="provider-stats"><span>今日 Token：${todayTokens}</span><span>今日请求：${requests} 次</span><span>平均响应：${averageResponse}</span><span>今日消耗：${consumption}</span></div>${!skipBalance && balance.error ? `<div class="balance-error">${escapeHtml(balance.error)}</div>` : ''}${provider.error ? `<div class="balance-error">${escapeHtml(provider.error)}</div>` : ''}<div class="provider-actions">${connectButton}<button class="test">测试连接</button>${skipBalance ? '' : '<button class="refresh-balance">刷新余额</button>'}<button class="edit">编辑</button><button class="delete">删除</button></div>`;
  }
  card.querySelector('.provider-toggle')?.addEventListener('click', () => {
    if (providersCollapsed) {
      if (expandedProviderIds.has(provider.id)) expandedProviderIds.delete(provider.id);
      else expandedProviderIds.add(provider.id);
      localStorage.setItem('api-pet-expanded-provider-ids', JSON.stringify([...expandedProviderIds]));
    } else if (collapsedProviderIds.has(provider.id)) {
      collapsedProviderIds.delete(provider.id);
      localStorage.setItem('api-pet-collapsed-provider-ids', JSON.stringify([...collapsedProviderIds]));
    } else {
      collapsedProviderIds.add(provider.id);
      localStorage.setItem('api-pet-collapsed-provider-ids', JSON.stringify([...collapsedProviderIds]));
    }
    render();
  });
  card.querySelectorAll('.provider-reorder').forEach(button => {
    button.addEventListener('click', async () => {
      if (button.disabled || providerOrderSaving) return;
      providerOrderSaving = true;
      list.querySelectorAll('.provider-reorder').forEach(item => { item.disabled = true; });
      try {
        appState = await window.apiPet.moveProvider({ id: provider.id, direction: button.dataset.direction });
        render();
      } catch (error) {
        list.querySelectorAll('.provider-reorder').forEach(item => { item.disabled = false; });
        toast(`调整顺序失败：${error?.message || error}`);
      } finally { providerOrderSaving = false; }
    });
  });
  card.querySelector('.test')?.addEventListener('click', () => testProvider(provider.id));
    card.querySelector('.connect-account')?.addEventListener('click', () => connectProviderAccount(provider.id));
    card.querySelector('.refresh-balance')?.addEventListener('click', () => refreshBalance(provider.id));
    card.querySelector('.edit')?.addEventListener('click', () => openEdit(provider));
    card.querySelector('.delete')?.addEventListener('click', async () => { if (confirm('删除这个 Provider？')) { appState = await window.apiPet.deleteProvider(provider.id); render(); } });
    list.appendChild(card);
  });
  updateCompactMoneyColumns();
  renderMode();
  renderChatTargetMenu();
  updateChatModelLabel();
  updatePetBalanceStatus();
}
function setupProviderDragSort(card) {
  card.classList.add('provider-sortable');
  card.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || event.target.closest('button') || providerOrderSaving || providerDrag) return;
    const list = $('providers');
    const scroller = list.closest('.panel-scroll');
    const startX = event.clientX;
    const startY = event.clientY;
    let pointerY = startY;
    let offsetY = 0;
    let ghost;
    let frame;
    const session = { dragging: false, cancel: () => finish(false) };
    providerDrag = session;
    const cleanup = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', cancel);
      list.removeEventListener('lostpointercapture', cancel);
      providerDrag = null;
      if (list.hasPointerCapture(event.pointerId)) list.releasePointerCapture(event.pointerId);
      ghost?.remove();
      card.classList.remove('provider-sort-placeholder');
      appRoot.classList.remove('sorting-providers');
    };
    const finish = async save => {
      if (providerDrag !== session) return;
      const dragging = session.dragging;
      const targetIndex = [...list.children].indexOf(card);
      cleanup();
      if (!dragging) return;
      if (save && appState.providers.findIndex(provider => provider.id === card.dataset.providerId) !== targetIndex) {
        providerOrderSaving = true;
        list.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
          appState = await window.apiPet.moveProvider({ id: card.dataset.providerId, targetIndex });
        } catch (error) { toast(`调整顺序失败：${error?.message || error}`); }
        finally { providerOrderSaving = false; }
      }
      render();
    };
    const position = () => {
      ghost.style.top = `${pointerY - offsetY}px`;
      const before = [...list.children].find(row => row !== card && pointerY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
      if (before) list.insertBefore(card, before);
      else list.appendChild(card);
    };
    const scroll = () => {
      const bounds = scroller.getBoundingClientRect();
      const speed = pointerY < bounds.top + 32 ? -8 : pointerY > bounds.bottom - 32 ? 8 : 0;
      if (speed) { scroller.scrollTop += speed; position(); }
      frame = requestAnimationFrame(scroll);
    };
    const move = pointer => {
      if (pointer.pointerId !== event.pointerId) return;
      pointerY = pointer.clientY;
      if (!session.dragging) {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) > 8) finish(false);
        return;
      }
      pointer.preventDefault();
      position();
    };
    const release = pointer => { if (pointer.pointerId === event.pointerId) finish(true); };
    const cancel = () => finish(false);
    const keydown = key => { if (key.key === 'Escape') { key.preventDefault(); finish(false); } };
    const timer = setTimeout(() => {
      const rect = card.getBoundingClientRect();
      offsetY = startY - rect.top;
      ghost = card.cloneNode(true);
      ghost.classList.add('provider-sort-ghost');
      ghost.classList.remove('provider-sortable');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.style.gridTemplateColumns = getComputedStyle(card).gridTemplateColumns;
      document.body.appendChild(ghost);
      session.dragging = true;
      card.classList.add('provider-sort-placeholder');
      appRoot.classList.add('sorting-providers');
      window.getSelection()?.removeAllRanges();
      list.setPointerCapture(event.pointerId);
      frame = requestAnimationFrame(scroll);
    }, 400);
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', keydown);
    window.addEventListener('blur', cancel);
    list.addEventListener('lostpointercapture', cancel);
    list.setPointerCapture(event.pointerId);
  });
}
function updateCompactMoneyColumns() {
  if (panel.classList.contains('hidden')) return;
  const list = $('providers');
  const compactCards = [...list.querySelectorAll('.provider-card-compact')];
  const moneyColumnWidth = (selector, minimum) => Math.max(minimum, ...compactCards.map(card => {
    const range = document.createRange();
    range.selectNodeContents(card.querySelector(selector));
    return Math.ceil(range.getBoundingClientRect().width) + 2;
  }));
  list.style.setProperty('--compact-consumption-width', `${moneyColumnWidth('.provider-compact-consumption', 48)}px`);
  list.style.setProperty('--compact-balance-width', `${moneyColumnWidth('.provider-compact-balance', 64)}px`);
}
function renderMode() {
  const enabled = appState.routingEnabled === true;
  const unified = appState.routingMode === 'unified';
  $('routingEnabled').checked = enabled;
  $('routingMode').value = unified ? 'unified' : 'model';
  $('unifiedRoute').classList.toggle('hidden', !enabled || !unified);
  $('routes').classList.toggle('hidden', !enabled || unified);
  $('routingGateway')?.classList.toggle('hidden', !enabled);
  if (!enabled) return;
  unified ? renderUnifiedRoute() : renderRoutes();
}
function renderUnifiedRoute() {
  const route = appState.unifiedRoute || {};
  const provider = appState.providers.find(item => item.id === route.providerId);
  const models = (provider?.models || []).slice().sort();
  const format = route.format === 'chat/completions' ? 'chat/completions' : 'responses';
  $('unifiedRoute').innerHTML = `<div class="unified-card"><div class="unified-field"><label>API<select id="unifiedProvider"><option value="">选择 API Provider</option>${appState.providers.map(item => `<option value="${item.id}" ${item.id === route.providerId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label></div><div class="unified-arrow">→</div><div class="unified-field"><label>模型<select id="unifiedTargetModel"><option value="">选择模型</option>${models.map(model => `<option value="${escapeHtml(model)}" ${model === route.model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}</select></label></div><div class="unified-format"><label>上游格式<select id="unifiedFormat"><option value="responses" ${format === 'responses' ? 'selected' : ''}>responses</option><option value="chat/completions" ${format === 'chat/completions' ? 'selected' : ''}>chat/completions</option></select></label></div><div class="unified-caption">客户端模型为 <b>Pet model</b>；调用端点：<b>/v1/${escapeHtml(format)}</b></div></div>`;
  $('unifiedProvider').onchange = async () => { appState = await window.apiPet.setUnifiedRoute({ providerId: $('unifiedProvider').value, model: '', format }); renderUnifiedRoute(); toast('API 已选择'); };
  $('unifiedTargetModel').onchange = async () => { appState = await window.apiPet.setUnifiedRoute({ providerId: route.providerId, model: $('unifiedTargetModel').value, format }); renderUnifiedRoute(); toast('统一模型已保存'); };
  $('unifiedFormat').onchange = async () => { appState = await window.apiPet.setUnifiedRoute({ providerId: route.providerId, model: route.model, format: $('unifiedFormat').value }); renderUnifiedRoute(); toast('上游格式已保存'); };
}
function renderRoutes() {
  const models = [...new Set(appState.providers.flatMap(provider => provider.models || []))].sort();
  $('routes').innerHTML = models.length ? models.map(model => { const selected = appState.routes[model] || ''; const options = appState.providers.filter(provider => (provider.models || []).includes(model)).map(provider => `<option value="${provider.id}" ${selected === provider.id ? 'selected' : ''}>${escapeHtml(provider.name)}</option>`).join(''); return `<div class="route-row"><b>${escapeHtml(model)}</b><select data-model="${escapeHtml(model)}"><option value="">自动选择</option>${options}</select></div>`; }).join('') : '<div style="font-size:11px;color:#a88b98;padding:8px 0">测试 Provider 后会在这里显示模型路由</div>';
  $('routes').querySelectorAll('select').forEach(select => { select.onchange = async () => { appState = await window.apiPet.setRoute({ model: select.dataset.model, providerId: select.value }); toast('路由已保存'); }; });
}
function fillProviderDialog(provider = {}) {
  ensureTokenRemarkField();
  // A Provider can be saved before its first API key is available.
  const legacyKeyInput = $('providerKey');
  if (legacyKeyInput) legacyKeyInput.required = false;
  $('quickEntryField').classList.toggle('hidden', Boolean(provider.id));
  $('quickEntry').value = '';
  $('providerId').value = provider.id || '';
  $('providerName').value = provider.name || '';
  $('loginUrl').value = provider.loginUrl || provider.baseUrl || '';
  $('requestUrl').value = provider.requestUrl || '';
  providerTokenRows = Array.isArray(provider.apiKeys) && provider.apiKeys.length
    ? provider.apiKeys.map(item => ({ key: item.key || '', remark: item.remark || '', enabled: item.enabled !== false }))
    : [{ key: provider.apiKey || '', remark: provider.tokenRemark || '', enabled: true }];
  renderTokenRows();
  $('accountToken').value = provider.accountToken || '';
  $('accountUserId').value = provider.accountUserId || '';
  $('balanceAdapter').value = provider.balanceAdapter || 'sub2api';
  $('balanceUrl').value = provider.balanceUrl || '';
  $('balanceMethod').value = provider.balanceMethod || 'GET';
  $('balancePath').value = provider.balancePath || 'data.balance';
  $('remainingPath').value = provider.remainingPath || '';
  $('currency').value = provider.currency || '$';
  updateProviderTypeFields();
}
function updateProviderTypeFields() {
  const type = $('balanceAdapter').value;
  const skipBalance = type === 'none';
  const supportsAccountLogin = ['sub2api', 'new-api', 'aihub'].includes(type);
  $('accountTokenField').classList.toggle('hidden', !supportsAccountLogin);
  $('accountUserIdField').classList.toggle('hidden', type !== 'new-api');
  ['balanceUrlField', 'balanceMethodField', 'balancePathField', 'remainingPathField'].forEach(id => $(id)?.classList.toggle('hidden', supportsAccountLogin || skipBalance));
  $('currency').closest('label').classList.toggle('hidden', skipBalance);
  ['connectAccountInDialog', 'importProviderTokens'].forEach(id => $(id)?.classList.toggle('hidden', skipBalance));
}
function ensureTokenRemarkField() {
  if ($('tokenFields')) return;
  const keyInput = $('providerKey');
  const keyLabel = keyInput?.closest('label');
  if (!keyLabel) return;
  const fields = document.createElement('div');
  fields.id = 'tokenFields';
  fields.className = 'token-fields';
  keyLabel.parentNode.insertBefore(fields, keyLabel);
  keyLabel.remove();
}
function renderTokenRows() {
  const fields = $('tokenFields');
  if (!fields) return;
  fields.innerHTML = `<div class="token-row token-header"><span></span><div class="token-column-head"><span class="token-field-title">API Key</span></div><div class="token-column-head"><span class="token-field-title">令牌备注</span></div><div class="token-row-actions token-header-actions"><button type="button" id="importProviderTokens" class="ghost small token-import">导入令牌</button></div></div>${providerTokenRows.map((row, index) => `<div class="token-row" data-token-index="${index}"><input class="token-enabled" type="checkbox" title="使用此 API Key" ${row.enabled !== false ? 'checked' : ''}><div class="token-column"><div class="secret-input"><input id="token-key-${index}" class="token-key" type="password" value="${escapeHtml(row.key)}" placeholder="sk-xxxxxxxx"><button type="button" class="toggle-token-key toggle-secret" aria-label="显示 API Key" title="显示 API Key"><span class="eye-icon" aria-hidden="true"></span></button></div></div><div class="token-column"><input id="token-remark-${index}" class="token-remark" value="${escapeHtml(row.remark)}" placeholder="例如 主账号 / GPT 专用"></div><div class="token-row-actions"><div class="token-row-action-buttons"><button type="button" class="add-token" title="增加 API Key">＋</button><button type="button" class="remove-token" title="删除 API Key" ${providerTokenRows.length <= 1 ? 'disabled' : ''}>−</button></div></div></div>`).join('')}`;
  $('importProviderTokens')?.addEventListener('click', importProviderTokens);
  fields.querySelectorAll('.token-row[data-token-index]').forEach(row => {
    const index = Number(row.dataset.tokenIndex);
    row.querySelector('.token-key').oninput = event => { providerTokenRows[index].key = event.target.value; };
    row.querySelector('.token-remark').oninput = event => { providerTokenRows[index].remark = event.target.value; };
    row.querySelector('.token-enabled').onchange = event => {
      if (event.target.checked) providerTokenRows.forEach((item, itemIndex) => { item.enabled = itemIndex === index; });
      else providerTokenRows[index].enabled = true;
      renderTokenRows();
    };
    row.querySelector('.add-token').onclick = () => { providerTokenRows.splice(index + 1, 0, { key: '', remark: '', enabled: false }); renderTokenRows(); };
    row.querySelector('.remove-token').onclick = () => {
      if (providerTokenRows.length <= 1) return;
      const removedSelected = providerTokenRows[index].enabled;
      providerTokenRows.splice(index, 1);
      if (removedSelected) providerTokenRows[Math.min(index, providerTokenRows.length - 1)].enabled = true;
      renderTokenRows();
    };
    row.querySelector('.toggle-token-key').onclick = () => { const input = row.querySelector('.token-key'); input.type = input.type === 'password' ? 'text' : 'password'; };
  });
  updateProviderTypeFields();
}
function recognizeProviderQuickEntry() {
  const text = $('quickEntry').value.trim();
  if (!text) { toast('请先粘贴站点信息'); return; }
  const result = window.ProviderQuickEntry.parse(text);
  if (result.name) $('providerName').value = result.name;
  if (result.loginUrl) $('loginUrl').value = result.loginUrl;
  if (result.apiKey) {
    const index = Math.max(0, providerTokenRows.findIndex(row => row.enabled));
    providerTokenRows[index].key = result.apiKey;
    renderTokenRows();
  }
  const missing = [[result.loginUrl, '登录地址'], [result.apiKey, 'API Key']].filter(([value]) => !value).map(([, label]) => label);
  if (missing.length === 2 && !result.name) toast('未识别到站点信息，请粘贴网址和 API Key');
  else toast(missing.length ? `已填写识别到的信息；未识别到${missing.join('、')}，请手动补充` : '已识别并填写名称、登录地址和 API Key，请核对后保存');
}
async function importProviderTokens() {
  const button = $('importProviderTokens');
  button.disabled = true;
  button.textContent = '正在导入…';
  try {
    const result = await window.apiPet.importProviderTokens(editingId || { provider: collectProviderDraft() });
    if (!result.ok) { toast(result.error || '导入令牌失败'); return; }
    if (result.credentials) {
      draftAccountData = { ...draftAccountData, ...result.credentials };
      $('accountToken').value = result.credentials.accountToken || '';
      $('accountUserId').value = result.credentials.accountUserId || '';
    }
    const selectedKey = providerTokenRows.find(row => row.enabled)?.key || '';
    const selectedIndex = result.tokens.findIndex(token => token.key === selectedKey);
    providerTokenRows = result.tokens.map((token, index) => ({ key: token.key, remark: token.name, enabled: index === (selectedIndex >= 0 ? selectedIndex : 0) }));
    renderTokenRows();
    toast(`已导入 ${providerTokenRows.length} 个令牌；点击“保存并测试”后生效`);
  } catch (error) {
    toast(String(error?.message || error));
  } finally {
    const currentButton = $('importProviderTokens');
    if (currentButton) { currentButton.disabled = false; currentButton.textContent = '导入令牌'; }
  }
}
function collectProviderDraft() {
  return {
    name: $('providerName').value.trim(),
    loginUrl: $('loginUrl').value.trim(),
    requestUrl: $('requestUrl').value.trim(),
    balanceAdapter: $('balanceAdapter').value || 'sub2api',
    accountToken: $('accountToken').value.trim(),
    accountRefreshToken: draftAccountData?.accountRefreshToken || '',
    accountUserId: $('accountUserId').value.trim(),
    accountCookie: draftAccountData?.accountCookie || '',
    accountSession: draftAccountData?.accountSession || '',
    currency: $('currency').value
  };
}
function openEdit(provider) { editingId = provider.id; draftAccountData = null; $('dialogTitle').textContent = '编辑 Provider'; fillProviderDialog(provider); appRoot.classList.add('provider-dialog-open'); dialog.showModal(); }
function openAdd() { editingId = null; draftAccountData = null; $('dialogTitle').textContent = '添加 Provider'; fillProviderDialog(); appRoot.classList.add('provider-dialog-open'); dialog.showModal(); }
async function saveProviderAndTest() {
  const form = $('providerForm');
  if (!form.reportValidity()) return;
  const apiKeys = providerTokenRows.map(row => ({ key: String(row.key || '').trim(), remark: String(row.remark || '').trim(), enabled: row.enabled !== false })).filter(row => row.key);
  appState = await window.apiPet.saveProvider({ id: editingId, name: $('providerName').value, loginUrl: $('loginUrl').value, requestUrl: $('requestUrl').value, apiKeys, apiKey: apiKeys.find(row => row.enabled)?.key || apiKeys[0]?.key || '', tokenRemark: apiKeys.find(row => row.enabled)?.remark || '', accountToken: $('accountToken').value, accountRefreshToken: draftAccountData?.accountRefreshToken || '', accountCookie: draftAccountData?.accountCookie || '', accountSession: draftAccountData?.accountSession || '', accountUserId: $('accountUserId').value, accountStats: draftAccountData?.accountStats || null, balance: draftAccountData?.balance || null, balanceAdapter: $('balanceAdapter').value, balanceUrl: $('balanceUrl').value, balanceMethod: $('balanceMethod').value, balancePath: $('balancePath').value, remainingPath: $('remainingPath').value, currency: $('currency').value });
  dialog.close();
  render();
  const provider = appState.providers.find(item => item.id === editingId) || appState.providers.at(-1);
  if (provider && provider.apiKey) await testProvider(provider.id);
  else toast('Provider 已保存；添加 API Key 后再测试连接');
}
async function testProvider(id) {
  if (providerTestsActive === 0) connectionAnimationPlayed = false;
  providerTestsActive += 1;
  updatePetAnimation();
  toast('正在测试连接…');
  try {
    const result = await window.apiPet.testProvider(id);
    appState = result.state;
    render();
    toast(result.ok ? `连接成功，获取 ${result.models.length} 个模型` : `连接失败：${result.error}`);
    return result;
  } finally {
    providerTestsActive = Math.max(0, providerTestsActive - 1);
    if (providerTestsActive === 0) connectionAnimationPlayed = false;
    updatePetAnimation();
  }
}
async function refreshBalance(id) {
  beginManualBalanceQuery();
  toast('正在查询余额…');
  try {
    appState = await window.apiPet.refreshProviderBalance(id);
    render();
    toast('余额信息已更新');
  } finally {
    endManualBalanceQuery();
  }
}
async function connectProviderAccount(id, loginUrl = '', { silent = false } = {}) {
  if (connectingAccounts === 0) connectionAnimationPlayed = false;
  connectingAccounts += 1;
  updatePetAnimation();
  if (!silent) toast('请在打开的窗口中登录站点账户…');
  try {
    const result = await window.apiPet.connectProviderAccount(id ? { id, loginUrl } : { id: '', loginUrl, provider: collectProviderDraft() });
    appState = result.state;
    if (result.ok && !id && result.provider) {
      draftAccountData = result.provider;
      $('accountToken').value = result.provider.accountToken || '';
      $('accountUserId').value = result.provider.accountUserId || '';
      if (result.provider.balanceAdapter) {
        $('balanceAdapter').value = result.provider.balanceAdapter;
        $('balanceAdapter').dispatchEvent(new Event('change'));
      }
    } else if (result.ok && editingId === id) {
      $('accountToken').value = appState.providers.find(provider => provider.id === id)?.accountToken || '';
      $('accountUserId').value = appState.providers.find(provider => provider.id === id)?.accountUserId || '';
    }
    render();
    if (!silent) toast(result.ok ? '账户已连接，余额和今日统计已更新' : `连接失败：${result.error}`);
    return result;
  } finally {
    connectingAccounts = Math.max(0, connectingAccounts - 1);
    if (connectingAccounts === 0) connectionAnimationPlayed = false;
    updatePetAnimation();
  }
}
async function refreshAllProviderAccounts() {
  const button = $('refreshAllAccounts');
  const providers = appState.providers.filter(provider => ['sub2api', 'new-api', 'aihub'].includes(provider.balanceAdapter));
  if (!providers.length || refreshingAllAccounts) return;
  refreshingAllAccounts = true;
  button.disabled = true;
  let succeeded = 0;
  let failed = 0;
  try {
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      button.textContent = `连接中 ${index + 1}/${providers.length}`;
      toast(`正在连接 ${provider.name}（${index + 1}/${providers.length}）…`);
      try {
        const result = await connectProviderAccount(provider.id, '', { silent: true });
        if (result?.ok) succeeded += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    toast(`账户刷新完成：成功 ${succeeded} 个，失败 ${failed} 个，跳过 ${appState.providers.length - providers.length} 个`);
  } finally {
    refreshingAllAccounts = false;
    button.textContent = '一键刷新账户';
    button.disabled = appState.providers.every(provider => !['sub2api', 'new-api', 'aihub'].includes(provider.balanceAdapter));
  }
}
let chatHistory = [];
function clearChatContext() {
  if (chatSending) return;
  chatHistory = [];
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.textContent = '输入消息，开始对话';
  $('chatMessages').replaceChildren(empty);
  document.querySelectorAll('.image-viewer').forEach(viewer => { viewer.close(); viewer.remove(); });
  toast('对话记录和上下文已清空');
  $('chatInput').focus();
}
function currentChatFormat() {
  return appState?.routingMode === 'unified' && appState?.unifiedRoute?.format === 'chat/completions'
    ? 'chat/completions' : 'responses';
}
function currentChatModel() {
  if (chatModelSelection) return chatModelSelection;
  if (chatSiteSelection) return '';
  if (appState?.routingMode === 'unified') return 'Pet model';
  return appState?.providers?.flatMap(provider => provider.models || [])[0] || '';
}
function getChatSite() {
  const provider = appState?.providers?.find(item => item.id === chatSiteSelection);
  return provider || null;
}
function currentChatProviderId() {
  return getChatSite()?.id || '';
}
function currentChatKeyIndex() {
  return chatKeySelection === '' ? null : Number(chatKeySelection);
}
function ensureChatTargetMenu() {
  if ($('chatSite') && $('chatModel')) return;
  const messages = $('chatMessages');
  if (!messages) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-targets';
  wrapper.innerHTML = '<label class="chat-target-label">站点<select id="chatSite"><option value="">自动选择</option></select></label><label class="chat-target-label">Key<select id="chatKey"><option value="">先选择站点</option></select></label><label class="chat-target-label">模型<select id="chatModel"><option value="">自动选择</option></select></label>';
  messages.before(wrapper);
  $('chatSite').onchange = async () => {
    chatSiteSelection = $('chatSite').value;
    localStorage.setItem('api-pet-chat-site', chatSiteSelection);
    chatKeySelection = '';
    chatFetchedModels = [];
    chatFetchedProviderId = '';
    chatFetchedKeyIndex = -1;
    chatModelSelection = '';
    localStorage.setItem('api-pet-chat-model', '');
    chatModelsLoading = false;
    chatModelFetchToken += 1;
    renderChatTargetMenu();
    updateChatModelLabel();
  };
  $('chatKey').onchange = async () => {
    chatKeySelection = $('chatKey').value;
    chatFetchedModels = [];
    chatFetchedProviderId = '';
    chatFetchedKeyIndex = -1;
    chatModelSelection = '';
    localStorage.setItem('api-pet-chat-model', '');
    const providerId = chatSiteSelection;
    const keyIndex = currentChatKeyIndex();
    const fetchToken = ++chatModelFetchToken;
    if (!providerId || keyIndex == null) {
      renderChatTargetMenu();
      updateChatModelLabel();
      return;
    }
    chatModelsLoading = true;
    renderChatTargetMenu();
    updateChatModelLabel();
    if (providerTestsActive === 0) connectionAnimationPlayed = false;
    providerTestsActive += 1;
    updatePetAnimation();
    toast('正在使用所选 Key 获取模型…');
    try {
      const result = await window.apiPet.getChatModels({ providerId, keyIndex });
      if (fetchToken !== chatModelFetchToken) return;
      if (!result.ok) throw new Error(result.error || '无法获取模型列表');
      const models = result.models || [];
      chatFetchedModels = models;
      chatFetchedProviderId = providerId;
      chatFetchedKeyIndex = keyIndex;
      chatModelSelection = models[0] || (appState.routingMode === 'unified' ? 'Pet model' : '');
      localStorage.setItem('api-pet-chat-model', chatModelSelection);
      toast(`已获取 ${models.length} 个模型`);
    } catch (error) {
      if (fetchToken === chatModelFetchToken) {
        chatKeySelection = '';
        chatModelSelection = '';
        localStorage.setItem('api-pet-chat-model', '');
        toast(`获取模型失败：${error.message}`);
      }
    } finally {
      if (fetchToken === chatModelFetchToken) {
        chatModelsLoading = false;
        renderChatTargetMenu();
        updateChatModelLabel();
      }
      providerTestsActive = Math.max(0, providerTestsActive - 1);
      if (providerTestsActive === 0) connectionAnimationPlayed = false;
      updatePetAnimation();
    }
  };
  $('chatModel').onchange = () => {
    chatModelSelection = $('chatModel').value;
    localStorage.setItem('api-pet-chat-model', chatModelSelection);
    updateChatModelLabel();
  };
}
function renderChatTargetMenu() {
  const siteSelect = $('chatSite');
  const keySelect = $('chatKey');
  const modelSelect = $('chatModel');
  if (!siteSelect || !keySelect || !modelSelect || !appState) return;
  siteSelect.disabled = chatSending;
  const sites = appState.providers || [];
  const selectedSite = sites.find(provider => provider.id === chatSiteSelection);
  const keys = selectedSite?.apiKeys || (selectedSite?.apiKey ? [{ key: selectedSite.apiKey, remark: selectedSite.tokenRemark || '' }] : []);
  const keyIndex = currentChatKeyIndex();
  const hasFetchedSelection = chatFetchedProviderId === selectedSite?.id && chatFetchedKeyIndex === keyIndex;
  const models = selectedSite
    ? (hasFetchedSelection ? [...new Set(chatFetchedModels)].sort() : [])
    : [...new Set(sites.flatMap(provider => provider.models || []))].sort();
  if (appState.routingMode === 'unified') models.unshift('Pet model');
  siteSelect.innerHTML = `<option value="">自动选择</option>${sites.map(provider => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('')}`;
  keySelect.innerHTML = selectedSite
    ? `<option value="">选择 Key</option>${keys.map((key, index) => `<option value="${index}">${escapeHtml(key.remark || `Key ${index + 1}`)}</option>`).join('')}`
    : '<option value="">先选择站点</option>';
  keySelect.disabled = !selectedSite;
  if (chatModelsLoading && selectedSite) {
    modelSelect.innerHTML = '<option value="">正在获取模型…</option>';
    modelSelect.disabled = true;
  } else if (selectedSite && keyIndex == null) {
    modelSelect.innerHTML = '<option value="">先选择 Key</option>';
    modelSelect.disabled = true;
  } else if (selectedSite && !hasFetchedSelection) {
    modelSelect.innerHTML = '<option value="">选择 Key 获取模型</option>';
    modelSelect.disabled = true;
  } else {
    modelSelect.disabled = false;
    modelSelect.innerHTML = `<option value="">自动选择</option>${models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')}`;
  }
  chatSiteSelection = sites.some(provider => provider.id === chatSiteSelection) ? chatSiteSelection : '';
  chatModelSelection = models.includes(chatModelSelection) ? chatModelSelection : (models[0] || '');
  siteSelect.value = chatSiteSelection;
  keySelect.value = selectedSite && keys[keyIndex] ? String(keyIndex) : '';
  if (!chatModelsLoading) modelSelect.value = chatModelSelection;
  if (chatSending) [siteSelect, keySelect, modelSelect].forEach(select => { select.disabled = true; });
}
function currentDrawingModel() {
  const model = currentChatModel();
  if (model !== 'Pet model') return model;
  return (getChatSite() ? chatFetchedModels[0] || getChatSite().models?.[0] : appState?.unifiedRoute?.model) || '';
}
function renderDrawingParameters() {
  let parameters = $('drawingParameters');
  if (!parameters) {
    parameters = document.createElement('div');
    parameters.id = 'drawingParameters';
    parameters.className = 'drawing-parameters hidden';
    $('chatForm').before(parameters);
    parameters.addEventListener('change', event => {
      const field = event.target.dataset.drawing;
      if (!field) return;
      drawingOptions[field] = ['width', 'height', 'count'].includes(field) ? Number(event.target.value)
        : ['watermark', 'promptExtend'].includes(field) ? event.target.value === 'on' : event.target.value;
      renderDrawingParameters();
    });
  }
  const drawing = $('chatMode').value === 'image';
  parameters.classList.toggle('hidden', !drawing);
  if (!drawing) return;
  const model = currentDrawingModel(), kind = imageConfig.modelKind(model);
  if (['gemini', 'sense-fast'].includes(kind) && drawingOptions.resolution === 'custom') drawingOptions.resolution = '1K';
  const selection = imageConfig.getImageSizeSelection({ ...drawingOptions, model });
  Object.assign(drawingOptions, selection);
  if (kind === 'sense-lite') drawingOptions.count = 1;
  const sizes = imageConfig.getImageSizeOptions(model, selection.resolution);
  const field = (label, key, options) => `<label>${label}<select data-drawing="${key}" ${chatSending ? 'disabled' : ''}>${options.map(([value, text]) => `<option value="${value}" ${String(drawingOptions[key]) === String(value) ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
  const resolutions = sizes.resolutions.map(value => [value, value === 'auto' ? '自动' : value]);
  if (!['gemini', 'grok', 'grok-json', 'sense-fast'].includes(kind)) resolutions.push(['custom', '自定义']);
  let html = field('分辨率', 'resolution', resolutions);
  if (selection.resolution === 'custom') {
    for (const key of ['width', 'height']) html += `<label>${key === 'width' ? '宽度' : '高度'}<input type="number" data-drawing="${key}" min="${kind === 'sense-lite' ? 512 : 1}" max="${kind === 'sense-lite' ? 4096 : 16384}" step="${kind === 'sense-lite' ? 32 : 1}" value="${selection[key]}" ${chatSending ? 'disabled' : ''}></label>`;
  } else if (selection.resolution !== 'auto' || kind === 'gemini') html += field('比例', 'ratio', sizes.ratios.map(value => [value, value]));
  if (kind.startsWith('sense')) {
    html += field('水印', 'watermark', [['on', '开'], ['off', '关']]);
    if (kind === 'sense-lite') {
      html += field('自动润色', 'promptExtend', [['on', '开'], ['off', '关']]);
      html += field('输出格式', 'outputFormat', [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']]);
    }
  } else if (kind !== 'gemini') {
    const qualities = kind === 'grok-json' ? [['medium', '中'], ['low', '低'], ['auto', '自动']] : [['high', '高'], ['medium', '中'], ['low', '低'], ['auto', '自动']];
    if (!qualities.some(([value]) => value === drawingOptions.quality)) drawingOptions.quality = 'auto';
    html += field('质量', 'quality', qualities);
  }
  html += field('数量', 'count', (kind === 'sense-lite' ? [1] : [1, 2, 3, 4, 5]).map(value => [value, `${value} 张`]));
  if (kind !== 'gemini' && kind !== 'seedream') html += field('返回方式', 'responseFormat', [['url', 'URL'], ['b64_json', 'Base64']]);
  if (chatImages.length && ['generic', 'grok', 'grok-json'].includes(kind)) html += field('图生图接口', 'editEndpoint', [['auto', '自动'], ['edits', 'edits'], ['generations', 'generations']]);
  parameters.innerHTML = html;
  // Boolean controls use on/off values, while request options retain actual booleans.
  ['watermark', 'promptExtend'].forEach(key => {
    const select = parameters.querySelector(`[data-drawing="${key}"]`);
    if (select) select.value = drawingOptions[key] ? 'on' : 'off';
  });
}
function updateChatModelLabel() {
  const model = currentChatModel();
  const drawing = $('chatMode').value === 'image';
  const format = drawing ? (chatImages.length ? '图生图' : '文生图') : `/v1/${currentChatFormat()}`;
  const enabled = Boolean(model);
  const site = getChatSite();
  const targetLabel = site ? `${site.name} · ${model}` : model;
  $('chatModelLabel').textContent = enabled && model ? `${targetLabel} · ${format}` : '请先选择可用模型';
  renderDrawingParameters();
}
function appendChatMessage(role, text, images = []) {
  const list = $('chatMessages');
  list.querySelector('.chat-empty')?.remove();
  const message = document.createElement('div');
  message.className = `chat-message ${role}`;
  message.textContent = text;
  if (images.length) {
    const gallery = document.createElement('div');
    gallery.className = 'chat-message-images';
    images.forEach(image => {
      const preview = document.createElement('img');
      preview.src = image.url;
      preview.alt = image.name;
      gallery.appendChild(preview);
    });
    message.appendChild(gallery);
  }
  list.appendChild(message);
  list.scrollTop = list.scrollHeight;
  return message;
}
function extractChatText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const choice = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) return choice.map(item => item?.text || item?.content || '').join('');
  if (Array.isArray(payload?.output)) return payload.output.flatMap(item => item?.content || []).map(item => item?.text || '').join('');
  return '';
}
async function sendChatMessage(text) {
  const model = currentChatModel();
  if (!model) throw new Error('没有可用模型，请先测试 Provider');
  const format = currentChatFormat();
  const providerId = currentChatProviderId();
  const request = {
    model,
    format,
    providerId,
    apiKeyIndex: currentChatKeyIndex(),
    targetModel: model === 'Pet model' && chatFetchedModels.length ? chatFetchedModels[0] : '',
    messages: chatHistory.map(item => ({ role: item.role, content: item.content })),
    input: chatHistory.some(item => Array.isArray(item.content))
      ? chatHistory.map(item => ({ role: item.role, content: Array.isArray(item.content)
        ? item.content.map(part => part.type === 'image_url'
          ? { type: 'input_image', image_url: part.image_url.url }
          : { type: 'input_text', text: part.text })
        : [{ type: 'input_text', text: item.content }] }))
      : chatHistory.map(item => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`).join('\n')
  };
  const result = await window.apiPet.chatRequest(request);
  if (!result?.ok) throw new Error(result?.error || '直连请求失败');
  const payload = result.payload || {};
  const answer = extractChatText(payload).trim();
  if (!answer) throw new Error('模型返回了空内容');
  return answer;
}
function updateChatMode() {
  const imageMode = $('chatMode').value === 'image';
  chatPanel.classList.toggle('image-mode', imageMode);
  $('chatInput').placeholder = imageMode ? '描述你想生成的图片…' : '输入你的消息…';
  $('sendChat').disabled = chatSending || chatImagesLoading > 0;
  $('clearChat').disabled = chatSending;
  $('chatMode').disabled = chatSending;
  $('addChatImage').disabled = chatSending;
  $('chatInput').required = imageMode || chatImages.length === 0;
  $('sendChat').removeAttribute('title');
  $('sendChat').textContent = chatSending ? (imageMode ? '生成中…' : '请求中…') : imageMode ? '生成' : '发送';
  updateChatModelLabel();
}
function enableGeneratedImageCopy(element, url) {
  element.addEventListener('contextmenu', async event => {
    event.preventDefault();
    try {
      const result = await window.apiPet.showGeneratedImageMenu(url);
      if (!result.ok) throw new Error(result.error || '复制失败');
      if (result.copied) toast('图片已复制');
    } catch (error) { toast(`复制失败：${error.message}`); }
  });
}
function showGeneratedImages(message, images) {
  message.className = 'chat-message assistant generated-message';
  message.replaceChildren();
  images.forEach((image, index) => {
    const card = document.createElement('div');
    card.className = 'generated-image';
    const preview = document.createElement('img');
    preview.src = image.url;
    preview.alt = `生成图片 ${index + 1}`;
    preview.title = '点击放大，右键复制';
    enableGeneratedImageCopy(preview, image.url);
    preview.onerror = () => { preview.alt = '图片预览失败，请点击保存重试'; };
    preview.onclick = () => {
      const viewer = document.createElement('dialog');
      viewer.className = 'image-viewer';
      const full = document.createElement('img');
      full.src = image.url; full.alt = preview.alt;
      enableGeneratedImageCopy(full, image.url);
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'icon'; close.textContent = '×'; close.setAttribute('aria-label', '关闭图片预览');
      close.onclick = () => viewer.close();
      viewer.append(close, full); document.body.appendChild(viewer);
      viewer.onclose = () => viewer.remove(); viewer.showModal();
    };
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'ghost small'; save.textContent = '保存图片';
    save.onclick = async () => {
      save.disabled = true;
      try {
        const result = await window.apiPet.saveGeneratedImage(image.url);
        if (!result.ok) throw new Error(result.error);
        if (!result.canceled) toast('图片已保存');
      } catch (error) { toast(`保存失败：${error.message}`); }
      finally { save.disabled = false; }
    };
    card.append(preview, save);
    if (image.warning) { const warning = document.createElement('div'); warning.className = 'generation-warning'; warning.textContent = image.warning; card.appendChild(warning); }
    message.appendChild(card);
  });
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}
async function handleDrawingSubmit(text) {
  if (!text) return;
  const images = chatImages;
  const request = { ...drawingOptions, prompt: text, model: currentChatModel(), providerId: currentChatProviderId(),
    apiKeyIndex: currentChatKeyIndex(), targetModel: currentDrawingModel(), referenceImages: images.map(image => image.url) };
  chatImages = []; chatSending = true;
  $('chatInput').value = '';
  renderChatAttachments(); renderChatTargetMenu();
  appendChatMessage('user', text, images);
  const pending = appendChatMessage('assistant pending', images.length ? '正在根据参考图生成…' : '正在生成图片…');
  providerTestsActive += 1; updatePetAnimation();
  try {
    const result = await window.apiPet.generateImages(request);
    if (!result.ok) throw new Error(result.error || '绘图失败');
    showGeneratedImages(pending, result.images);
    if (result.errors?.length) {
      const warning = document.createElement('div'); warning.className = 'generation-warning';
      warning.textContent = `部分生成失败：${result.errors.join('；')}。已保留成功图片。`;
      pending.appendChild(warning);
    }
  } catch (error) {
    pending.className = 'chat-message error'; pending.textContent = error.message || '绘图失败';
    $('chatInput').value = [text, $('chatInput').value].filter(Boolean).join('\n');
    chatImages = images;
  } finally {
    chatSending = false;
    providerTestsActive = Math.max(0, providerTestsActive - 1); updatePetAnimation();
    renderChatAttachments(); renderChatTargetMenu(); $('chatInput').focus();
  }
}
function renderChatAttachments() {
  const tray = $('chatAttachments');
  tray.replaceChildren();
  tray.classList.toggle('hidden', !chatImages.length);
  chatImages.forEach(image => {
    const item = document.createElement('div');
    item.className = 'chat-attachment';
    const preview = document.createElement('img');
    preview.src = image.url;
    preview.alt = image.name;
    preview.title = image.name;
    const remove = document.createElement('button');
    remove.className = 'chat-image-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `移除 ${image.name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.disabled = chatSending;
    remove.onclick = () => {
      chatImages = chatImages.filter(item => item !== image);
      renderChatAttachments();
    };
    item.append(preview, remove);
    tray.appendChild(item);
  });
  updateChatMode();
}
function readChatImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve({ name: file.name, url: reader.result });
      image.onerror = () => reject(new Error('图片无法解码'));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function addChatImages(files) {
  if (chatSending || !files.length) return;
  const selected = Array.from(files);
  chatImagesLoading += 1;
  updateChatMode();
  chatImageQueue = chatImageQueue.then(async () => {
    const errors = [];
    for (const file of selected) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
        errors.push(`${file.name}：请选择 PNG、JPEG、WebP 或 GIF 图片`);
        continue;
      }
      if (file.size > CHAT_IMAGE_MAX_BYTES) {
        errors.push(`${file.name}：单张图片不能超过 10 MB`);
        continue;
      }
      if (chatImages.length >= CHAT_IMAGE_LIMIT) {
        errors.push('每条消息最多上传 4 张图片');
        break;
      }
      try { chatImages.push(await readChatImage(file)); }
      catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
    if (errors.length) toast(errors.join('\n'));
  }).finally(() => {
    chatImagesLoading -= 1;
    renderChatAttachments();
  });
  return chatImageQueue;
}
function setupChatImageUpload() {
  $('addChatImage').onclick = () => $('chatImageFiles').click();
  $('chatImageFiles').onchange = event => {
    addChatImages(event.target.files);
    event.target.value = '';
  };
  chatPanel.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = chatSending ? 'none' : 'copy';
    if (!chatSending) chatPanel.classList.add('drag-over');
  });
  chatPanel.addEventListener('dragleave', event => {
    if (!chatPanel.contains(event.relatedTarget)) chatPanel.classList.remove('drag-over');
  });
  chatPanel.addEventListener('drop', event => {
    event.preventDefault();
    chatPanel.classList.remove('drag-over');
    addChatImages(event.dataTransfer?.files || []);
  });
}
async function handleChatSubmit(event) {
  event.preventDefault();
  const input = $('chatInput');
  const sendButton = $('sendChat');
  const text = input.value.trim();
  if ((!text && !chatImages.length) || sendButton.disabled) return;
  if ($('chatMode').value === 'image') { await handleDrawingSubmit(text); return; }
  const images = chatImages;
  chatImages = [];
  chatSending = true;
  renderChatTargetMenu();
  renderChatAttachments();
  input.value = '';
  appendChatMessage('user', text, images);
  chatHistory.push({ role: 'user', content: images.length
    ? [...(text ? [{ type: 'text', text }] : []), ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } }))]
    : text });
  sendButton.disabled = true;
  $('chatMode').disabled = true;
  sendButton.textContent = '请求中…';
  const pending = appendChatMessage('assistant pending', '正在思考…');
  try {
    const answer = await sendChatMessage(text);
    pending.className = 'chat-message assistant';
    pending.textContent = answer;
    chatHistory.push({ role: 'assistant', content: answer });
  } catch (error) {
    pending.className = 'chat-message error';
    pending.textContent = error.message || '请求失败';
    chatHistory.pop();
    input.value = [text, input.value].filter(Boolean).join('\n');
    chatImages = images;
  } finally {
    chatSending = false;
    renderChatAttachments();
    renderChatTargetMenu();
    input.focus();
  }
}
function setStatus(data) {
  const label = data.target && data.target !== data.model ? `${data.model} → ${data.target}` : data.model;
  if (data.status !== 'requesting') {
    window.apiPet.getState().then(state => { appState = state; render(); }).catch(() => {});
  }
}
window.addEventListener('DOMContentLoaded', async () => {
  const dialogToast = document.createElement('div');
  dialogToast.id = 'dialogToast';
  dialogToast.className = 'dialog-toast';
  dialog.querySelector('.dialog-head')?.after(dialogToast);
  ensureChatTargetMenu();
  setupPanelHeightResize();
  setupPanelWidthResize();
  window.apiPet.onBalanceActivity(setBalanceActivity);
  appState = await window.apiPet.getState();
  setBalanceActivity(await window.apiPet.getBalanceActivity());
  updatePetAnimation();
  ensureProviderToggle();
  moveGatewayIntoRouting();
  render();
  $('openChat').onclick = () => setChatVisible(chatPanel.classList.contains('hidden'));
  $('openSettings').onclick = () => setPanelVisible(panel.classList.contains('hidden'));
  $('chatForm').onsubmit = handleChatSubmit;
  $('clearChat').onclick = clearChatContext;
  $('chatMode').onchange = updateChatMode;
  setupChatImageUpload();
  updateChatMode();
  $('closeChat').onclick = () => setChatVisible(false);
  $('closePanel').onclick = () => setPanelVisible(false);
  $('addProvider').onclick = openAdd;
  $('recognizeProvider').onclick = recognizeProviderQuickEntry;
  $('quickEntry').onpaste = event => {
    const text = event.clipboardData?.getData('text/plain') || '';
    if (/[\r\n]/.test(text)) {
      event.preventDefault();
      $('quickEntry').setRangeText(text.replace(/[\r\n]+/g, ' '), $('quickEntry').selectionStart, $('quickEntry').selectionEnd, 'end');
    }
  };
  $('quickEntry').onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); recognizeProviderQuickEntry(); }
  };
  $('quit').onclick = () => window.apiPet.quit();
  $('copyUrl').onclick = () => copyGatewayValue('unifiedUrl', 'URL');
  $('copyKey').onclick = () => copyGatewayValue('unifiedKey', '统一 Key');
  $('copyModel').onclick = () => copyGatewayValue('unifiedModel', 'Pet 模型');
  $('refreshAllBalances').onclick = async () => {
    beginManualBalanceQuery();
    toast('正在刷新余额…');
    try {
      appState = await window.apiPet.refreshAllBalances();
      render();
      toast('余额信息已更新');
    } finally {
      endManualBalanceQuery();
    }
  };
  $('saveBalanceSettings').onclick = async () => { appState = await window.apiPet.setBalanceSettings({ lowThreshold: $('lowThreshold').value, refreshMinutes: $('refreshMinutes').value }); render(); toast('余额设置已保存'); };
  $('routingEnabled').onchange = async () => { appState = await window.apiPet.setRoutingEnabled($('routingEnabled').checked); renderMode(); toast(appState.routingEnabled ? '已启用模型路由' : '已关闭模型路由'); };
  $('routingMode').onchange = async () => { appState = await window.apiPet.setRoutingMode($('routingMode').value); renderMode(); toast($('routingMode').value === 'unified' ? '已切换到统一路由模式' : '已切换到模型路由模式'); };
  $('balanceAdapter').onchange = updateProviderTypeFields;
  $('connectAccountInDialog').onclick = () => connectProviderAccount(editingId, $('loginUrl').value.trim());
  ensureTokenRemarkField();
  $('providerForm').onsubmit = event => event.preventDefault();
  $('saveProvider').type = 'button';
  $('saveProvider').onclick = saveProviderAndTest;
  [dialog.querySelector('.dialog-head button'), dialog.querySelector('.dialog-actions .ghost')].forEach(button => {
    button.type = 'button';
    button.onclick = () => dialog.close('cancel');
  });
  dialog.addEventListener('close', () => {
    appRoot.classList.remove('provider-dialog-open');
    $('dialogToast')?.classList.remove('show');
  });
  window.apiPet.onGatewayStatus(setStatus);
  window.apiPet.onShowPanel(() => setPanelVisible(true));
});
