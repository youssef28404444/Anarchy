(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const pages = [...document.querySelectorAll('[data-page]')];
  const links = [...document.querySelectorAll('[data-route]')];
  const nav = document.querySelector('.an-links');
  const menu = document.querySelector('.an-menu');
  const toast = document.querySelector('.toast');
  let toastTimer, memberFilter = 'All', editingMemberId = null;
  const KEY = 'anarchy.workspace.';
  const API_BASE = String(window.ANARCHY_API_BASE || 'http://localhost:5000').replace(/\/$/, '');
  let backendAvailable = false, authConfigured = false, localPreviewMode = false, currentUser = null, currentAccess = { permissions: [] }, botStatus = { online: false };
  const api = async (path, options = {}) => { const response = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) } }); const data = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(data.message || data.error || `Request failed (${response.status})`); error.status = response.status; error.data = data; throw error; } return data; };
  const assetUrl = value => { const raw = String(value || ''); if (!raw || /^(?:https?:|data:|blob:)/i.test(raw)) return raw; return `${API_BASE}/${raw.replace(/^\//,'')}`; };
  const mouseGlow = document.querySelector('.mouse-glow');
  if (mouseGlow && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let glowFrame = 0;
    document.addEventListener('mousemove', event => { document.body.classList.add('mouse-active'); if (glowFrame) cancelAnimationFrame(glowFrame); const x=event.clientX,y=event.clientY; glowFrame=requestAnimationFrame(()=>{mouseGlow.style.transform=`translate3d(${x}px,${y}px,0) translate(-50%,-50%)`;}); }, {passive:true});
    document.addEventListener('mouseleave',()=>document.body.classList.remove('mouse-active'));
  }
  const can = permission => currentAccess?.permissions?.includes('admin:all') || currentAccess?.permissions?.includes(permission);
  let roleMappings = readRoleMappingsFallback();
  function readRoleMappingsFallback() { try { return JSON.parse(localStorage.getItem('anarchy.workspace.roleMappings') || '{}'); } catch { return {}; } }
  const DEFAULT_CATEGORIES = ['Leader', 'Co-Boss', 'AC Gang'];
  const read = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(KEY + key)); return value ?? fallback; } catch { return fallback; } };
  const COLLECTION_KEYS = { members:'members', categories:'categories', tasks:'tasks', taskTemplates:'taskTemplates', resources:'resources', gunModels:'gunModels', gunStock:'gunStock' };
  let syncQueue = Promise.resolve(), hydratingBackend = false;
  const save = (key, value) => {
    localStorage.setItem(KEY + key, JSON.stringify(value));
    if (backendAvailable && currentUser && currentAccess?.inGuild && COLLECTION_KEYS[key] && !hydratingBackend) {
      syncQueue = syncQueue.then(() => syncCollection(key, value)).catch(error => { console.error('[ANARCHY sync]', error); showToast(`Saved locally, but backend sync failed: ${error.message}`); });
    }
  };
  async function syncCollection(key, value) {
    const route = COLLECTION_KEYS[key];
    const permission = ({members:'members:manage',categories:'members:manage',tasks:'tasks:manage',resources:'resources:manage',gunModels:'guns:manage',gunStock:'guns:manage',taskTemplates:'tasks:manage'})[key];
    if (!can(permission)) throw new Error(`Your Discord roles cannot manage ${key}.`);
    const toRecord = item => key === 'categories' ? ({ id:item, name:item }) : item;
    const local = value.map(toRecord);
    const remote = await api(`/api/data/${route}`);
    const localIds = new Set(local.map(item => String(item.id)));
    for (const item of local) await api(`/api/data/${route}`, { method:'POST', body:JSON.stringify(item) });
    for (const item of remote.items || []) if (!localIds.has(String(item.id))) await api(`/api/data/${route}/${encodeURIComponent(item.id)}`, { method:'DELETE' });
  }
  async function hydrateBackendCollections() {
    if (!currentUser || !currentAccess?.inGuild) return;
    hydratingBackend = true;
    try {
      const mappings = [
        ['members','members:read',items => items], ['categories','members:read',items => items.map(item => item.name).filter(Boolean)],
        ['tasks','tasks:read',items => items], ['taskTemplates','tasks:read',items => items], ['resources','resources:read',items => items],
        ['gunModels','guns:read',items => items], ['gunStock','guns:read',items => items]
      ];
      for (const [key, permission, transform] of mappings) {
        if (!can(permission)) continue;
        try { const data = await api(`/api/data/${COLLECTION_KEYS[key]}`); const values = transform(data.items || []); localStorage.setItem(KEY + key, JSON.stringify(values));
          if (key === 'members') members = values;
          if (key === 'categories') { categories = [...new Set([...DEFAULT_CATEGORIES, ...values])]; }
          if (key === 'tasks') tasks = values;
          if (key === 'taskTemplates') taskTemplates = values;
          if (key === 'resources') resources = values;
          if (key === 'gunModels') gunModels = values;
          if (key === 'gunStock') gunStock = values;
        } catch (error) { if (error.status !== 403) console.warn(`[ANARCHY] Could not hydrate ${key}:`, error.message); }
      }
    } finally { hydratingBackend = false; }
    renderMembers(); renderTasks(); renderResources(); renderGuns(); renderLeaderboard(); applyUiPermissions(); loadAssignableGangMembers().catch(()=>{});
  }
  function applyUiPermissions() {
    const map = [
      ['open-member-form','members:manage'], ['category-form','members:manage'], ['open-task-form','tasks:manage'],
      ['open-resource-form','resources:manage'], ['open-gun-model-form','guns:manage'], ['open-gun-stock-form','guns:manage'],
      ['role-map-form','settings:write'], ['sync-discord-members','roles:manage'], ['refresh-discord-members','roles:manage'],
      ['announcement-form','announcements:send'], ['refresh-logs','logs:read'], ['apply-logs-filter','logs:read'], ['clock-adjust-form','clock:manage'], ['refresh-clock','clock:manage']
    ];
    if (!backendAvailable || localPreviewMode) { document.querySelectorAll('.permission-hidden').forEach(element => element.classList.remove('permission-hidden')); return; }
    if (!currentUser) { map.forEach(([id]) => { const element = $(id); if (element) element.classList.add('permission-hidden'); }); document.querySelectorAll('.member-card-actions,.delete-category,.delete-task,.delete-resource,.delete-gun-model,.delete-gun-stock,.task-status-select,.discord-member-actions').forEach(element => element.classList.add('permission-hidden')); return; }
    map.forEach(([id, permission]) => { const element = $(id); if (element) element.classList.toggle('permission-hidden', !can(permission)); });
    ['role-owner','role-boss'].forEach(id => { if ($(id)) $(id).disabled = !can('admin:all'); });
    document.querySelectorAll('.member-card-actions,.delete-category').forEach(element => element.classList.toggle('permission-hidden', !can('members:manage')));
    document.querySelectorAll('.delete-task,.task-status-select').forEach(element => element.classList.toggle('permission-hidden', !can('tasks:manage')));
    document.querySelectorAll('.delete-resource').forEach(element => element.classList.toggle('permission-hidden', !can('resources:manage')));
    document.querySelectorAll('.delete-gun-model,.delete-gun-stock').forEach(element => element.classList.toggle('permission-hidden', !can('guns:manage')));
    document.querySelectorAll('.discord-member-actions').forEach(element => element.classList.toggle('permission-hidden', !can('roles:manage')));
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const trashIcon = '<svg class="trash-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg>';
  let pendingGunImage = '';
  function setGunImagePreview(src) { pendingGunImage = src || ''; $('gun-image-preview').src = pendingGunImage; $('gun-image-preview-wrap').classList.toggle('hidden', !pendingGunImage); }
  $('gun-model-image')?.addEventListener('change', async event => { try { setGunImagePreview(await readImageFile(event.target.files?.[0])); } catch (error) { event.target.value = ''; setGunImagePreview(''); showToast(error.message || 'Could not load image.'); } });
  $('clear-gun-image')?.addEventListener('click', () => { $('gun-model-image').value = ''; setGunImagePreview(''); });
  const showToast = (message, type) => { const text = String(message ?? ''); const state = type || (/\b(error|failed|fail|denied|invalid|unable|could not|فشل|خطأ|غير مسموح|تعذر)\b/i.test(text) ? 'error' : (/\b(saved|success|sent|updated|added|removed|تم|نجاح|اتحفظ|اترسل|اتحدث)\b/i.test(text) ? 'success' : 'info')); toast.textContent = text; toast.classList.remove('toast-success','toast-error','toast-info'); toast.classList.add('toast-' + state, 'show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 3200); };
  // Subtle pointer-following red light; disabled on touch-only devices.
  if (window.matchMedia && window.matchMedia('(pointer:fine)').matches) { let pointerFrame = 0; document.addEventListener('pointermove', event => { if (pointerFrame) return; pointerFrame = requestAnimationFrame(() => { document.documentElement.style.setProperty('--pointer-x', event.clientX + 'px'); document.documentElement.style.setProperty('--pointer-y', event.clientY + 'px'); pointerFrame = 0; }); }, { passive:true }); }
  const toggleForm = (id, open) => $(id).classList.toggle('hidden', !open);

  let categories = read('categories', DEFAULT_CATEGORIES).filter(x => typeof x === 'string' && x.trim());
  for (const role of DEFAULT_CATEGORIES) if (!categories.includes(role)) categories.push(role);
  categories = [...new Set([...DEFAULT_CATEGORIES, ...categories.filter(category => !DEFAULT_CATEGORIES.includes(category))])];
  let members = read('members', []).map(m => ({...m, id: m.id ?? uid(), role: m.role === 'Cops' ? 'Co-Boss' : (categories.includes(m.role) ? m.role : 'AC Gang')}));
  let tasks = read('tasks', []);
  let taskTemplates = read('taskTemplates', []);
  let assignableGangMembers = [];
  async function loadAssignableGangMembers() {
    if (!backendAvailable || !currentUser || !can('tasks:manage')) return;
    try { const data = await api('/api/tasks/assignable-members'); assignableGangMembers = data.members || []; const select = $('task-assignee'); if (select) { const previous = select.value; select.innerHTML = '<option value="">Choose an AC Gang member</option>' + assignableGangMembers.map(m => `<option value="${esc(m.user_id)}">${esc(m.global_name || m.username)} (@${esc(m.username)})</option>`).join(''); if (assignableGangMembers.some(m => m.user_id === previous)) select.value = previous; } } catch (error) { showToast(`Could not load AC Gang members: ${error.message}`, 'error'); }
  }
  let resources = read('resources', []);
  let gunModels = read('gunModels', []);
  let gunStock = read('gunStock', []);
  roleMappings = read('roleMappings', roleMappings || {});

  function renderRoute() {
    const requested = (location.hash || '#home').slice(1).toLowerCase().split('?')[0];
    let route = pages.some(page => page.dataset.page === requested) ? requested : 'home';
    const protectedRoutes = { dashboard:'dashboard:read', tasks:'tasks:read', resources:'resources:read', guns:'guns:read', settings:'settings:read', 'discord-members':'members:read', announcements:'announcements:send', tickets:'profile:read', logs:'logs:read', clock:'clock:manage', 'media-management':'media:manage', 'leaderboard-management':'leaderboard:manage', 'overview-management':'admin:all', 'clips-management':'media:manage', 'gallery-management':'media:manage' };
    if (backendAvailable && !localPreviewMode && route === 'leaderboard' && (!currentUser || !can('leaderboard:read'))) { route='home'; if(location.hash !== '#home'){history.replaceState(null,'','#home');showToast(!currentUser ? 'Sign in with Discord to view the leaderboard.' : 'The leaderboard is available to configured AC Gang members and management roles.');} }
    if (backendAvailable && !localPreviewMode && route === 'tickets' && (!currentUser || !currentAccess?.inGuild)) { route = 'home'; if (location.hash !== '#home') { history.replaceState(null, '', '#home'); showToast('Join the configured Discord server and sign in to use tickets.'); } }
    if (backendAvailable && !localPreviewMode && protectedRoutes[route] && (!currentUser || !can(protectedRoutes[route]))) { route = 'home'; if (location.hash !== '#home') { history.replaceState(null, '', '#home'); showToast(!currentUser ? 'Sign in with Discord to open the management workspace.' : 'Your Discord roles do not allow access to that section.'); } }
    pages.forEach(page => { const active = page.dataset.page === route; page.classList.toggle('active', active); page.setAttribute('aria-hidden', String(!active)); });
    const navRoute = ['tasks','resources','guns','settings','discord-members','announcements','tickets','logs','media-management','leaderboard-management','overview-management','clips-management','gallery-management'].includes(route) ? 'dashboard' : route;
    links.forEach(link => { const active = link.dataset.route === navRoute; link.classList.toggle('active', active); active ? link.setAttribute('aria-current','page') : link.removeAttribute('aria-current'); if(link.dataset.route === 'dashboard') link.classList.toggle('permission-hidden', backendAvailable && !localPreviewMode && (!currentUser || !can('dashboard:read'))); if(link.dataset.route === 'leaderboard') link.classList.toggle('permission-hidden', backendAvailable && !localPreviewMode && (!currentUser || !can('leaderboard:read'))); });
    document.querySelectorAll('[data-requires]').forEach(el => el.classList.toggle('permission-hidden', backendAvailable && !localPreviewMode && (!currentUser || !can(el.dataset.requires))));
    nav?.classList.remove('open'); menu?.setAttribute('aria-expanded','false');
    if (menu) menu.innerHTML = '<i class="fa-solid fa-bars"></i>';
    window.scrollTo({top:0,behavior:'smooth'});
    document.title = 'ANARCHY — ' + route.charAt(0).toUpperCase() + route.slice(1);
    if (currentUser && route === 'discord-members') loadDiscordMembers().catch(error => showToast(error.message));
    if (route === 'media') loadSocialMedia(false).catch(() => renderSocialMedia([]));
    if (route === 'clips') loadPublishedContent('clips');
    if (route === 'gallery') loadPublishedContent('gallery');
    if (currentUser && route === 'media-management' && can('media:manage')) loadSocialMedia(true).catch(error => showToast(error.message));
    if (currentUser && route === 'tickets') loadTickets().catch(() => {});
    if (currentUser && route === 'logs' && can('logs:read')) loadLogs().catch(() => {});
    if (currentUser && route === 'clock' && can('clock:manage')) loadClockData().catch(error => showToast(error.message));
  }
  const discordLogin = document.getElementById('discord-login');
  discordLogin?.addEventListener('click', async event => {
    event.preventDefault();
    if (localPreviewMode) { showToast('Local preview is active. Configure Discord OAuth in backend/.env to enable login.'); return; }
    if (currentUser) {
      try { await api('/auth/logout', { method:'POST' }); currentUser = null; currentAccess = { permissions:[] }; location.hash = '#home'; await loadBackendState(); showToast('Logged out.'); }
      catch (error) { showToast(error.message); }
      return;
    }
    window.location.href = `${API_BASE}/auth/discord`;
  });

  window.addEventListener('hashchange', renderRoute);
  menu?.addEventListener('click', () => { const open = nav.classList.toggle('open'); menu.setAttribute('aria-expanded',String(open)); menu.innerHTML = open ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-bars"></i>'; });

  // Compress uploaded images so the local browser storage is less likely to fill up.
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve('');
      if (!file.type.startsWith('image/')) return reject(new Error('Choose an image file.'));
      if (file.size > 8 * 1024 * 1024) return reject(new Error('Image must be smaller than 8 MB.'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that image.'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('That image could not be opened.'));
        image.onload = () => {
          const max = 900, scale = Math.min(1, max / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', .82));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function persistProofImage(dataUrl, prefix='proof') {
    if (!dataUrl) return '';
    if (!backendAvailable || !currentUser || !currentAccess?.inGuild) return dataUrl;
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append('image', new File([blob], `${prefix}-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' }));
    const uploaded = await api('/api/uploads/image', { method:'POST', body:form });
    return uploaded.url;
  }

  const imageDrafts = {task:'', resource:''};
  function setProofImage(kind, src) {
    imageDrafts[kind] = src || '';
    const preview = $(`${kind}-image-preview`);
    const placeholder = $(`${kind}-image-placeholder`);
    preview.src = src || '';
    preview.classList.toggle('hidden', !src);
    placeholder.classList.toggle('hidden', !!src);
    $(`${kind}-image-zone`).classList.toggle('has-image', !!src);
  }
  async function loadProofFile(kind, file) {
    if (!file) return;
    try { setProofImage(kind, await readImageFile(file)); }
    catch (error) { showToast(error.message || 'Could not load image.'); }
  }
  ['task','resource'].forEach(kind => {
    const input = $(`${kind}-image-file`), zone = $(`${kind}-image-zone`);
    input.addEventListener('change', async event => { await loadProofFile(kind, event.target.files?.[0]); event.target.value = ''; });
    zone.addEventListener('click', event => { if (event.target.closest('[data-browse]')) return; zone.focus(); });
    zone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); zone.focus(); } });
    zone.addEventListener('paste', async event => {
      const item = [...(event.clipboardData?.items || [])].find(entry => entry.type.startsWith('image/'));
      if (!item) return;
      event.preventDefault(); await loadProofFile(kind, item.getAsFile());
    });
    zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('is-dragging'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
    zone.addEventListener('drop', async event => { event.preventDefault(); zone.classList.remove('is-dragging'); const file = [...(event.dataTransfer?.files || [])].find(entry => entry.type.startsWith('image/')); await loadProofFile(kind, file); });
  });
  document.querySelectorAll('[data-browse]').forEach(button => button.addEventListener('click', () => $(button.dataset.browse).click()));

  function renderCategoryControls() {
    const select = $('member-role');
    const selected = select.value;
    select.innerHTML = categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
    if (categories.includes(selected)) select.value = selected;
    $('category-list').innerHTML = categories.map((category, index) => {
      const isDefault = DEFAULT_CATEGORIES.includes(category);
      const count = members.filter(member => member.role === category).length;
      return `<div class="category-chip"><span class="category-order">${String(index + 1).padStart(2,'0')}</span><strong>${esc(category)}</strong><small>${count} member${count === 1 ? '' : 's'}</small>${isDefault ? '<span class="category-default">DEFAULT</span>' : `<button class="icon-action delete-category" data-category="${esc(category)}" type="button" aria-label="Delete ${esc(category)} category" title="Delete category">${trashIcon}</button>`}</div>`;
    }).join('');
    document.querySelectorAll('[data-filter]').forEach(button => {
      const category = button.dataset.filter;
      if (category !== 'All' && !categories.includes(category)) button.remove();
    });
    const filterBar = document.querySelector('.member-filters');
    categories.forEach(category => {
      if (!filterBar.querySelector(`[data-filter="${CSS.escape(category)}"]`)) {
        const button = document.createElement('button'); button.className = 'filter-btn'; button.dataset.filter = category; button.textContent = category; filterBar.appendChild(button);
      }
    });
    filterBar.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === memberFilter));
  }

  function renderMembers() {
    renderCategoryControls();
    const filtered = members.filter(member => memberFilter === 'All' || member.role === memberFilter);
    $('member-count').textContent = `CREW ROSTER / ${members.length} MEMBERS`;
    $('members-grid').innerHTML = filtered.map((member, index) => `<article class="crew-card"><div class="crew-avatar">${member.image ? `<img src="${esc(assetUrl(member.image))}" alt="${esc(member.name)} portrait">` : ''}<span ${member.image ? 'style="display:none"' : ''}>${esc((member.name || '?').trim().charAt(0).toUpperCase())}</span><b>${String(index + 1).padStart(2,'0')}</b></div><div class="crew-info"><small>${esc(member.role.toUpperCase())}</small><h3>${esc(member.name)}</h3><p>${esc(member.role)}</p><div class="member-card-actions"><button class="text-action edit-member" data-id="${esc(member.id)}" type="button"><i class="fa-solid fa-pen"></i> EDIT</button><button class="icon-action delete-member" data-id="${esc(member.id)}" type="button" aria-label="Delete member" title="Delete member">${trashIcon}</button></div></div><span class="rank-symbol">${member.role === 'Leader' ? '✦' : member.role === 'Co-Boss' ? '◆' : '◇'}</span></article>`).join('');
    $('members-empty').classList.toggle('hidden', filtered.length > 0);
    renderLeaderboard();
    applyUiPermissions();
  }

  $('open-member-form').addEventListener('click', () => { editingMemberId = null; $('member-form').reset(); $('member-image-file').required = false; $('member-form').querySelector('[type="submit"]').textContent = 'SAVE MEMBER'; toggleForm('member-form', true); });
  $('cancel-member').addEventListener('click', () => { editingMemberId = null; toggleForm('member-form', false); });
  $('member-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('member-name').value.trim(); if (!name) return;
    const file = $('member-image-file').files[0];
    try {
      const existing = editingMemberId ? members.find(member => String(member.id) === String(editingMemberId)) : null;
      let image = file ? await readImageFile(file) : (existing?.image || '');
      if(file && backendAvailable && currentUser && existing?.discordId){ const form=new FormData(); form.append('image',file); const uploaded=await api('/api/uploads/image',{method:'POST',body:form}); image=`${API_BASE}${uploaded.url}`; }
      if (existing) Object.assign(existing, {name, role:$('member-role').value, image});
      else members.push({id:uid(), name, role:$('member-role').value, image});
      save('members', members);
      if(backendAvailable && currentUser && existing?.discordId){ await api('/api/data/memberProfiles',{method:'POST',body:JSON.stringify({id:existing.discordId,name,role:$('member-role').value,image})}); }
      event.target.reset(); editingMemberId = null; toggleForm('member-form', false); renderMembers(); showToast(existing ? 'Member updated.' : 'Member added.');
    } catch (error) { showToast(error.message || 'Could not save member.'); }
  });
  document.querySelector('.member-filters').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button) return; memberFilter = button.dataset.filter; renderMembers(); });
  $('members-grid').addEventListener('click', event => {
    const edit = event.target.closest('.edit-member');
    if (edit) {
      const member = members.find(item => String(item.id) === edit.dataset.id); if (!member) return;
      editingMemberId = member.id; $('member-name').value = member.name; $('member-role').value = member.role; $('member-image-file').value = ''; $('member-image-file').required = false; $('member-form').querySelector('[type="submit"]').textContent = 'UPDATE MEMBER'; toggleForm('member-form', true); $('member-form').scrollIntoView({behavior:'smooth',block:'center'}); return;
    }
    const remove = event.target.closest('.delete-member'); if (!remove) return;
    if (!confirm('Remove this member from the local roster?')) return;
    members = members.filter(member => String(member.id) !== remove.dataset.id); save('members', members); renderMembers(); showToast('Member removed.');
  });

  $('category-form').addEventListener('submit', event => { event.preventDefault(); const name = $('category-name').value.trim(); if (!name) return; if (categories.some(category => category.toLowerCase() === name.toLowerCase())) return showToast('That category already exists.'); categories.push(name); save('categories', categories); $('category-form').reset(); renderMembers(); showToast('Category added.'); });
  $('category-list').addEventListener('click', event => { const button = event.target.closest('.delete-category'); if (!button) return; const category = button.dataset.category; if (DEFAULT_CATEGORIES.includes(category)) return showToast('Default categories cannot be deleted.'); const assigned = members.filter(member => member.role === category).length; const message = assigned ? `Delete ${category} and move ${assigned} member(s) to AC Gang?` : `Delete the ${category} category?`; if (!confirm(message)) return; members = members.map(member => member.role === category ? {...member, role:'AC Gang'} : member); categories = categories.filter(item => item !== category); if (memberFilter === category) memberFilter = 'All'; save('categories', categories); save('members', members); renderMembers(); showToast(assigned ? 'Category deleted; members moved to AC Gang.' : 'Category deleted.'); });

  function renderTaskTemplateControls() {
    const select = $('task-template-select');
    if (select) {
      const previous = select.value;
      select.innerHTML = '<option value="">Select a saved task preset</option>' + taskTemplates.map(item => `<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('');
      if (taskTemplates.some(item => String(item.id) === previous)) select.value = previous;
    }
    const list = $('task-templates-list');
    if (list) list.innerHTML = taskTemplates.map(item => `<article class="task-template-row"><div><strong>${esc(item.title)}</strong><p>${esc(item.description || 'No instructions added')}</p></div><button class="icon-action delete-task-template" data-id="${esc(item.id)}" type="button" title="Delete preset">${trashIcon}</button></article>`).join('') || '<p class="empty-state">No presets yet. Add a reusable task above.</p>';
  }
  function renderTasks() {
    const complete = tasks.filter(task => task.status === 'Completed').length;
    $('task-stats').innerHTML = `<div><strong>${tasks.length}</strong><span>TOTAL TASKS</span></div><div><strong>${tasks.filter(task => task.status === 'In Progress').length}</strong><span>IN PROGRESS</span></div><div><strong>${complete}</strong><span>COMPLETED</span></div>`;
    $('tasks-list').innerHTML = tasks.map(task => `<article class="task-row"><div class="task-icon"><i class="fa-solid fa-list-check"></i></div><div class="task-main"><h3>${esc(task.title)}</h3><p>${task.assignee ? 'Assigned to ' + esc(task.assigneeName || task.assignee) : 'Unassigned'}${task.createdByName ? ' · Added by ' + esc(task.createdByName) : ''}</p>${task.description ? `<p>${esc(task.description)}</p>` : ''}${task.image ? `<img class="task-proof-thumb" src="${esc(assetUrl(task.image))}" alt="Task proof">` : ''}</div><select class="task-status-select" data-id="${esc(task.id)}" aria-label="Task status"><option ${task.status==='Pending'?'selected':''}>Pending</option><option ${task.status==='In Progress'?'selected':''}>In Progress</option><option ${task.status==='Completed'?'selected':''}>Completed</option></select><button class="icon-action delete-task" data-id="${esc(task.id)}" type="button" aria-label="Delete task" title="Delete task">${trashIcon}</button></article>`).join('');
    $('tasks-empty').classList.toggle('hidden', tasks.length > 0);
    renderTaskTemplateControls(); applyUiPermissions();
  }
  $('open-task-form').addEventListener('click', async () => { renderTaskTemplateControls(); toggleForm('task-form', true); await loadAssignableGangMembers(); });
  $('cancel-task').addEventListener('click', () => { toggleForm('task-form', false); $('task-form').reset(); setProofImage('task',''); });
  $('open-task-template-form')?.addEventListener('click', () => toggleForm('task-template-form', true));
  $('cancel-task-template')?.addEventListener('click', () => { toggleForm('task-template-form', false); $('task-template-form').reset(); });
  $('task-template-form')?.addEventListener('submit', event => { event.preventDefault(); const title = $('task-template-title').value.trim(); if (!title) return; if (taskTemplates.some(item => item.title.toLowerCase() === title.toLowerCase())) return showToast('A preset with that name already exists.', 'error'); const item = {id:uid(),title,description:$('task-template-description').value.trim(),createdBy:currentUser?.id || null,createdByName:currentUser?.globalName || currentUser?.username || 'Local administrator',createdAt:new Date().toISOString()}; taskTemplates.push(item); save('taskTemplates',taskTemplates); event.target.reset(); toggleForm('task-template-form',false); renderTaskTemplateControls(); showToast('Task preset saved.', 'success'); });
  $('task-templates-list')?.addEventListener('click', event => { const button = event.target.closest('.delete-task-template'); if (!button) return; if (!confirm('Delete this task preset? Existing tasks will remain.')) return; taskTemplates = taskTemplates.filter(item => String(item.id) !== button.dataset.id); save('taskTemplates',taskTemplates); renderTaskTemplateControls(); showToast('Task preset deleted.', 'success'); });
  $('task-form').addEventListener('submit', async event => {
    event.preventDefault();
    const template = taskTemplates.find(item => String(item.id) === $('task-template-select').value);
    const member = assignableGangMembers.find(item => item.user_id === $('task-assignee').value);
    if (!template) return showToast('Choose a saved task preset first.', 'error');
    if (!member) return showToast('Choose an AC Gang member from the list.', 'error');
    if (!imageDrafts.task) return showToast('Add a task proof image using Browse or Ctrl + V.', 'error');
    const submit = event.submitter || event.target.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const proofImage = await persistProofImage(imageDrafts.task, 'task-proof');
      const item = {id:uid(),templateId:template.id,title:template.title,description:template.description || '',assignee:member.user_id,assigneeName:member.global_name || member.username,status:$('task-status').value,image:proofImage,createdBy:currentUser?.id || null,createdByName:currentUser?.globalName || currentUser?.username || 'Local administrator',createdAt:new Date().toISOString()};
      if (backendAvailable && currentUser && currentAccess?.inGuild) { await syncQueue; await api('/api/data/tasks', { method:'POST', body:JSON.stringify(item) }); } tasks.push(item); localStorage.setItem(KEY + 'tasks', JSON.stringify(tasks)); event.target.reset(); setProofImage('task',''); toggleForm('task-form',false); renderTasks();
      showToast('Task created and attributed to your signed-in account.', 'success');
    } catch(error) { showToast(error.message || 'Could not create task.', 'error'); }
    finally { if (submit) submit.disabled = false; }
  });
  $('tasks-list').addEventListener('change', event => { if (!event.target.matches('.task-status-select')) return; const task = tasks.find(item => String(item.id) === event.target.dataset.id); if (task) { task.status = event.target.value; save('tasks',tasks); renderTasks(); showToast('Task status updated.', 'success'); } });
  $('tasks-list').addEventListener('click', event => { const button = event.target.closest('.delete-task'); if (!button) return; if (!confirm('Delete this task?')) return; tasks = tasks.filter(task => String(task.id) !== button.dataset.id); save('tasks',tasks); renderTasks(); showToast('Task removed.', 'success'); });

  function renderResources() { $('resources-grid').innerHTML = resources.map(resource => `<article class="resource-card">${resource.image ? `<img class="proof-thumb" src="${esc(assetUrl(resource.image))}" alt="Resource handover proof">` : '<div class="resource-card-icon"><i class="fa-solid fa-boxes-stacked"></i></div>'}<div class="resource-details"><h3>${esc(resource.name)}</h3><p>${esc(resource.notes || 'No notes added')}</p></div><div class="resource-qty"><strong>${Number(resource.quantity)||0}</strong><small>QUANTITY</small></div><button class="icon-action delete-resource" data-id="${esc(resource.id)}" type="button" aria-label="Delete resource" title="Delete resource">${trashIcon}</button></article>`).join(''); $('resources-empty').classList.toggle('hidden', resources.length > 0); applyUiPermissions(); }
  $('open-resource-form').addEventListener('click', () => toggleForm('resource-form',true)); $('cancel-resource').addEventListener('click', () => { toggleForm('resource-form',false); $('resource-form').reset(); setProofImage('resource',''); });
  $('resource-form').addEventListener('submit', event => { event.preventDefault(); if (!imageDrafts.resource) return showToast('Add a handover or inventory screenshot using Browse or Ctrl + V.'); const item = {id:uid(),name:$('resource-name').value.trim(),quantity:Number($('resource-quantity').value),notes:$('resource-notes').value.trim(),image:imageDrafts.resource}; resources.push(item); try { save('resources',resources); } catch { resources.pop(); return showToast('Image is too large for local browser storage. Try a smaller screenshot.'); } event.target.reset(); setProofImage('resource',''); toggleForm('resource-form',false); renderResources(); showToast('Resource added.'); });
  $('resources-grid').addEventListener('click', event => { const button = event.target.closest('.delete-resource'); if (!button) return; resources = resources.filter(resource => String(resource.id) !== button.dataset.id); save('resources',resources); renderResources(); showToast('Resource removed.'); });

  function renderGuns() {
    $('gun-models-grid').innerHTML = gunModels.map(model => `<article class="resource-card weapon-card">${model.image ? `<img class="weapon-thumb" src="${esc(assetUrl(model.image))}" alt="${esc(model.name)}">` : `<div class="weapon-thumb weapon-thumb-placeholder"><span>◆</span></div>`}<div class="resource-details"><h3>${esc(model.name)}</h3><p>${esc(model.code || 'No model code')} · ${esc(model.notes || 'No notes')}</p></div><button class="icon-action delete-gun-model" data-id="${esc(model.id)}" type="button" aria-label="Delete weapon type" title="Delete weapon type">${trashIcon}</button></article>`).join('');
    $('gun-models-empty').classList.toggle('hidden', gunModels.length > 0);
    $('gun-stock-model').innerHTML = '<option value="">Choose weapon</option>' + gunModels.map(model => `<option value="${esc(model.id)}">${esc(model.name)}${model.code ? ' — '+esc(model.code) : ''}</option>`).join('');
    $('gun-stock-grid').innerHTML = gunStock.map(stock => { const model = gunModels.find(item => String(item.id) === String(stock.modelId)); return `<article class="resource-card weapon-card">${model?.image ? `<img class="weapon-thumb" src="${esc(assetUrl(model.image))}" alt="${esc(model.name)}">` : `<div class="weapon-thumb weapon-thumb-placeholder"><span>◆</span></div>`}<div class="resource-details"><h3>${esc(model?.name || 'Unknown weapon')}</h3><p>${esc(stock.notes || 'No notes / location')}</p></div><div class="resource-qty"><strong>${Number(stock.quantity)||0}</strong><small>IN STOCK</small></div><button class="icon-action delete-gun-stock" data-id="${esc(stock.id)}" type="button" aria-label="Delete stock record" title="Delete stock record">${trashIcon}</button></article>`; }).join('');
    $('gun-stock-empty').classList.toggle('hidden', gunStock.length > 0);
    applyUiPermissions();
  }
  $('open-gun-model-form').addEventListener('click', () => { setGunImagePreview(''); $('gun-model-form').reset(); toggleForm('gun-model-form',true); });
  $('cancel-gun-model').addEventListener('click', () => { $('gun-model-form').reset(); setGunImagePreview(''); toggleForm('gun-model-form',false); });
  $('gun-model-form').addEventListener('submit', event => { event.preventDefault(); const name = $('gun-model-name').value.trim(); if (!name) return; if (gunModels.some(model => model.name.toLowerCase() === name.toLowerCase())) return showToast('That weapon type already exists.'); gunModels.push({id:uid(),name,code:$('gun-model-code').value.trim(),notes:$('gun-model-notes').value.trim(),image:pendingGunImage}); try { save('gunModels',gunModels); } catch { gunModels.pop(); return showToast('Image is too large for browser storage. Choose a smaller image.'); } event.target.reset(); setGunImagePreview(''); toggleForm('gun-model-form',false); renderGuns(); showToast('Weapon type added.'); });
  $('gun-models-grid').addEventListener('click', event => { const button = event.target.closest('.delete-gun-model'); if (!button) return; if (gunStock.some(stock => String(stock.modelId) === button.dataset.id)) return showToast('Remove this weapon from stock first.'); gunModels = gunModels.filter(model => String(model.id) !== button.dataset.id); save('gunModels',gunModels); renderGuns(); showToast('Weapon type removed.'); });
  $('open-gun-stock-form').addEventListener('click', () => { if (!gunModels.length) return showToast('Add a weapon type first.'); toggleForm('gun-stock-form',true); }); $('cancel-gun-stock').addEventListener('click', () => toggleForm('gun-stock-form',false));
  $('gun-stock-form').addEventListener('submit', event => { event.preventDefault(); if (!$('gun-stock-model').value) return; gunStock.push({id:uid(),modelId:$('gun-stock-model').value,quantity:Number($('gun-stock-quantity').value),notes:$('gun-stock-notes').value.trim()}); save('gunStock',gunStock); event.target.reset(); toggleForm('gun-stock-form',false); renderGuns(); showToast('Armory stock record added.'); });
  $('gun-stock-grid').addEventListener('click', event => { const button = event.target.closest('.delete-gun-stock'); if (!button) return; gunStock = gunStock.filter(stock => String(stock.id) !== button.dataset.id); save('gunStock',gunStock); renderGuns(); showToast('Stock record removed.'); });

  const ROLE_FIELDS = {'role-owner':'owner','role-boss':'boss','role-coboss':'coboss','role-leader':'leader','role-member-manager':'memberManager','role-task-manager':'taskManager','role-resource-manager':'resourceManager','role-armory-manager':'armoryManager','role-gang':'gang','role-media-manager':'mediaManager','role-ticket-manager':'ticketManager','role-logs-viewer':'logsViewer','role-clock-manager':'clockManager'};
  const BOT_FIELDS = {'bot-activity-name':'activityName','bot-clock-channel':'clockChannelId','bot-log-channel':'logChannelId','bot-task-channel':'taskChannelId','bot-leaderboard-channel':'leaderboardChannelId','bot-announcement-channel':'announcementChannelId','bot-clip-request-channel':'clipRequestChannelId','bot-gallery-request-channel':'galleryRequestChannelId','bot-ticket-log-channel':'ticketLogChannelId','bot-support-category':'supportCategoryId'};
  function renderRoleMappings() { for (const [field,key] of Object.entries(ROLE_FIELDS)) if ($(field)) { if ($(field).tagName === 'SELECT' && discordConfigOptions.roles.length) fillDiscordSelect($(field), discordConfigOptions.roles, 'Choose a role…', roleMappings[key] || ''); else $(field).value = roleMappings[key] || ''; } }
  function renderBotSettings(settings = {}) { botSettingsCache = { ...botSettingsCache, ...settings }; for (const [field,key] of Object.entries(BOT_FIELDS)) if ($(field)) { const items = field === 'bot-support-category' ? discordConfigOptions.categories : discordConfigOptions.channels; if ($(field).tagName === 'SELECT' && items?.length) fillDiscordSelect($(field), items, 'Choose from Discord…', settings[key] || ''); else $(field).value = settings[key] || ''; } }
  let discordConfigOptions = { roles:[], channels:[], categories:[] };
  function fillDiscordSelect(select, items, placeholder, selected='') { if (!select) return; const current = String(selected || select.value || ''); select.innerHTML = `<option value="">${esc(placeholder)}</option>` + items.map(item => `<option value="${esc(item.id)}">${esc(item.name)}${item.position !== undefined ? ` · position ${item.position}` : ''}</option>`).join(''); if (items.some(item => item.id === current)) select.value = current; }
  async function loadDiscordConfigOptions() { try { const data = await api('/api/discord/config-options'); discordConfigOptions = data; document.querySelectorAll('[data-discord-role]').forEach(select => fillDiscordSelect(select, data.roles || [], 'Choose a role…', roleMappings[ROLE_FIELDS[select.id]] || '')); document.querySelectorAll('[data-discord-channel]').forEach(select => { const saved = BOT_FIELDS[select.id] ? botSettingsCache[BOT_FIELDS[select.id]] : select.value; fillDiscordSelect(select, data.channels || [], select.id === 'announcement-channel' ? 'Use default channel' : 'Choose a channel…', saved || ''); }); document.querySelectorAll('[data-discord-category]').forEach(select => fillDiscordSelect(select, data.categories || [], 'Choose a category…', botSettingsCache.supportCategoryId || '')); showToast(`Loaded ${data.roles.length} roles and ${data.channels.length} channels from ${data.guild.name}.` ); } catch (error) { console.warn('[ANARCHY] Discord config choices unavailable:', error.message); } }
  let botSettingsCache = {};
  $('role-map-form').addEventListener('submit', async event => {
    event.preventDefault();
    const nextRoles = { ...roleMappings };
    for (const [field,key] of Object.entries(ROLE_FIELDS)) nextRoles[key] = $(field).value.trim();
    const nextBot = {};
    for (const [field,key] of Object.entries(BOT_FIELDS)) nextBot[key] = $(field).value.trim();
    if (backendAvailable) {
      if (!currentUser) return showToast('Log in with Discord before saving server settings.');
      try { const result = await api('/api/settings', { method:'PATCH', body:JSON.stringify({ roleMappings:nextRoles, botSettings:nextBot }) }); roleMappings = result.roleMappings; save('roleMappings', roleMappings); renderRoleMappings(); renderBotSettings(result.botSettings); showToast('Role and bot settings saved successfully.'); }
      catch (error) { showToast(error.message || 'Could not save settings.'); }
      return;
    }
    roleMappings = nextRoles; save('roleMappings', roleMappings); renderBotSettings(nextBot); showToast('Local preview only: start the backend and sign in to save settings centrally.');
  });
  $('sync-discord-members')?.addEventListener('click', async () => { try { await api('/api/discord/sync', { method:'POST' }); await loadDiscordMembers(); showToast('Discord members and roles synced.'); } catch (error) { showToast(error.message); } });
  $('refresh-discord-members')?.addEventListener('click', async () => { try { await api('/api/discord/sync', { method:'POST' }); await loadDiscordMembers(); showToast('Discord roster synced.'); } catch (error) { showToast(error.message); } });
  $('export-backup').addEventListener('click', () => { const backup = {exportedAt:new Date().toISOString(),categories,members,tasks,resources,gunModels,gunStock,roleMappings}; const blob = new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'anarchy-workspace-backup.json'; a.click(); URL.revokeObjectURL(url); showToast('Local backup exported.'); });


  // Public media areas: local previews only until a shared backend is connected.
  async function loadPublishedContent(type){const target=type==='clips'?$('page-clips'):$('page-gallery');if(!target)return;try{const data=await api(`/api/public/content/${type}`);const items=data.items||[];let grid=target.querySelector('.published-content-grid');if(!grid){grid=document.createElement('div');grid.className='published-content-grid';target.querySelector('.page-wrap')?.append(grid);}grid.innerHTML=items.length?items.map(item=>type==='gallery'?`<article class=\"published-media-card\"><img src=\"${esc(assetUrl(item.url||item.image))}\" alt=\"${esc(item.title||item.name||'ANARCHY photo')}\" loading=\"lazy\"><span>${esc(item.title||item.name||'ANARCHY')}</span></article>`:`<article class=\"published-media-card published-video-card\"><video src=\"${esc(assetUrl(item.url||item.video))}\" controls preload=\"metadata\"></video><span>${esc(item.title||item.name||'ANARCHY clip')}</span></article>`).join(''):'<div class=\"empty-state published-empty\">No published content yet.</div>';}catch(_error){}}

  const clipUpload = $('clip-upload');
  clipUpload?.addEventListener('change', async () => {
    const file=clipUpload.files?.[0]; if ($('clip-filename')) $('clip-filename').textContent=file ? `${file.name} · ${(file.size/1024/1024).toFixed(1)} MB` : 'No clip selected';
    if(!file)return; if(!currentUser || !currentAccess?.inGuild) { showToast('Sign in with Discord to submit a clip request.','error'); clipUpload.value=''; return; }
    if(!confirm(`Submit “${file.name}” for administrator approval?`)) {clipUpload.value='';return;}
    try { const form=new FormData(); form.append('file',file); form.append('type','clip'); const result=await api('/api/submissions',{method:'POST',body:form}); showToast(`Clip request submitted (#${result.id}). Administrators have been notified.`,'success'); }
    catch(error){showToast(error.message || 'Could not submit clip request.','error');} finally {clipUpload.value='';}
  });

  const galleryUpload = $('gallery-upload');
  const galleryGrid = $('gallery-preview-grid');
  function addGalleryPreview(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const card = document.createElement('article');
    card.className = 'gallery-preview-card';
    const img = document.createElement('img');
    img.src = url; img.alt = file.name;
    const caption = document.createElement('span'); caption.textContent = file.name;
    card.append(img, caption);
    galleryGrid?.prepend(card);
  }
  galleryUpload?.addEventListener('change', () => {
    const files = [...(galleryUpload.files || [])];
    const label = $('gallery-filename');
    if (label) label.textContent = files.length ? `${files.length} photo${files.length === 1 ? '' : 's'} selected` : 'No photos selected';
    files.forEach(addGalleryPreview);
    if (files.length) submitGalleryFiles(files);
  });
  async function submitGalleryFiles(files) { if(!currentUser || !currentAccess?.inGuild) {showToast('Sign in with Discord to request a gallery upload.','error');return;} for(const file of files){try{const form=new FormData();form.append('file',file);form.append('type','gallery');const result=await api('/api/submissions',{method:'POST',body:form});showToast(`Photo request submitted (#${result.id}).`,'success');}catch(error){showToast(error.message || 'Could not submit photo request.','error');}} }
  document.addEventListener('paste', event => {
    if (location.hash !== '#gallery') return;
    const item = [...(event.clipboardData?.items || [])].find(entry => entry.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) { event.preventDefault(); addGalleryPreview(file); submitGalleryFiles([file]); }
  });

  function renderLeaderboard() {
    const target = $('leaderboard-list');
    if (!target) return;
    if (!members.length) { target.innerHTML = '<div class="empty-state">Add members to build the roster.</div>'; return; }
    const ranked = [...members].sort((a,b) => Number(b.points || 0) - Number(a.points || 0));
    target.innerHTML = ranked.map((member,index) => `<div class="leaderboard-row"><span class="leaderboard-rank">${String(index+1).padStart(2,'0')}</span><span class="leaderboard-member">${member.image ? `<img src="${esc(assetUrl(member.image))}" alt="">` : '<i class="fa-solid fa-user"></i>'}<b>${esc(member.name || 'Unnamed member')}</b></span><span class="leaderboard-category">${esc(member.role || 'Member')}</span><strong>${Number(member.points || 0)} <small>PTS</small></strong></div>`).join('');
  }
  // Keep all ordinary page text non-selectable, while form fields remain editable/copyable.
  document.documentElement.classList.add('anarchy-selection-locked');


  // Curated social channels: public read, management writes enforced by backend permissions.
  const PLATFORM_ORDER = ['kick','tiktok','youtube'];
  const PLATFORM_META = { kick:{label:'Kick',logo:'imgs/kick-logo.svg',tone:'kick'}, tiktok:{label:'TikTok',logo:'imgs/tiktok-logo.svg',tone:'tiktok'}, youtube:{label:'YouTube',logo:'imgs/youtube-logo.svg',tone:'youtube'} };
  let socialMediaItems = [];
  function renderSocialMedia(items = []) {
    const root = $('social-media-content'); if (!root) return;
    socialMediaItems = Array.isArray(items) ? items : [];
    if (!socialMediaItems.length) { root.innerHTML = '<div class="empty-state">No channels have been published yet. Check back soon.</div>'; return; }
    root.innerHTML = PLATFORM_ORDER.map(platform => {
      const meta = PLATFORM_META[platform]; const rows = socialMediaItems.filter(item => item.platform === platform && item.status !== 'pending');
      return `<section class="social-platform social-${platform}"><header><div class="social-platform-icon"><img src="${meta.logo}" alt="${meta.label} logo"></div><div><span class="section-kicker">ANARCHY CHANNELS</span><h2>${meta.label}</h2><p>${platform === 'kick' ? 'Live from the crew.' : platform === 'tiktok' ? 'Short-form moments and edits.' : 'Videos, highlights and uploads.'}</p></div><span class="social-count">${rows.length} CHANNEL${rows.length === 1 ? '' : 'S'}</span></header><div class="social-channel-grid">${rows.length ? rows.map(item => `<a class="social-channel-card" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${item.image ? `<img class="social-channel-avatar" src="${esc(assetUrl(item.image))}" alt="" loading="lazy">` : `<span class="social-channel-avatar social-avatar-fallback"><img src="${meta.logo}" alt="${meta.label} logo"></span>`}<span class="social-card-arrow"><i class="fa-solid fa-arrow-up-right-from-square"></i></span><small>${esc(item.role || 'AC Gang')}</small><h3>${esc(item.name || 'Crew channel')}</h3><p>${esc(item.note || 'Official ANARCHY creator')}</p><b>OPEN ${meta.label.toUpperCase()} ↗</b></a>`).join('') : '<div class="social-empty">No channels in this category yet.</div>'}</div></section>`;
    }).join('');
  }
  async function loadSocialMedia(manage = false) {
    if (manage && (!currentUser || !can('media:manage'))) return;
    try {
      const data = manage ? await api('/api/data/mediaLinks') : await api('/api/public/media');
      renderSocialMedia(data.items || []);
      if (manage) renderSocialMediaAdmin(data.items || []);
    } catch (error) {
      if (manage) throw error;
      renderSocialMedia(read('socialMediaPublic', []));
    }
  }
  function renderSocialMediaAdmin(items = []) {
    const root = $('social-media-admin-list'); if (!root) return;
    if (!items.length) { root.innerHTML = '<div class="empty-state">No published channels yet. Add the first channel above.</div>'; return; }
    root.innerHTML = items.map(item => `<article class="social-admin-row"><div><span class="social-admin-platform">${esc(PLATFORM_META[item.platform]?.label || item.platform)}</span><h3>${esc(item.name)}</h3><p>${esc(item.role || 'Member')} · <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open channel ↗</a></p></div><div class="social-admin-actions"><button class="btn btn-ghost social-edit" type="button" data-id="${esc(item.id)}">EDIT</button><button class="btn btn-ghost social-delete" type="button" data-id="${esc(item.id)}">DELETE</button></div></article>`).join('');
  }
  function resetSocialMediaForm() { if (!$('social-media-form')) return; $('social-media-form').reset(); $('social-media-id').value = ''; $('social-media-platform').value = 'kick'; }
  function renderSocialImagePreview(url='') { const target=$('social-media-image-preview'); if(!target)return; target.innerHTML=url ? `<img src="${esc(url)}" alt="Channel photo preview"><button class="btn btn-ghost" type="button" id="social-media-image-clear">REMOVE</button>` : ''; target.querySelector('#social-media-image-clear')?.addEventListener('click',()=>{ $('social-media-image').value=''; renderSocialImagePreview(''); }); }
  $('social-media-image-browse')?.addEventListener('click',()=> $('social-media-image-file')?.click());
  $('social-media-image-file')?.addEventListener('change',async()=>{ const file=$('social-media-image-file').files?.[0]; if(!file)return; try { const form=new FormData(); form.append('image',file); const result=await api('/api/uploads/image',{method:'POST',body:form}); const url=`${API_BASE}${result.url}`; $('social-media-image').value=url; renderSocialImagePreview(url); showToast('Channel photo uploaded.','success'); } catch(error){showToast(error.message || 'Could not upload channel photo.','error');} finally {$('social-media-image-file').value='';} });
  $('social-media-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!can('media:manage')) return showToast('You do not have permission to manage social channels.', 'error');
    const id = $('social-media-id').value || uid(); const url = $('social-media-url').value.trim();
    if (!/^https:\/\//i.test(url)) return showToast('Use a valid HTTPS channel link.', 'error');
    const item = { id, platform:$('social-media-platform').value, name:$('social-media-name').value.trim(), url, role:$('social-media-role').value, note:$('social-media-note').value.trim(), image:$('social-media-image').value.trim(), status:'published' };
    try { await api('/api/data/mediaLinks', {method:'POST', body:JSON.stringify(item)}); resetSocialMediaForm(); await loadSocialMedia(true); showToast('Channel saved and published.', 'success'); }
    catch (error) { showToast(error.message || 'Could not save channel.', 'error'); }
  });
  $('social-media-cancel')?.addEventListener('click', resetSocialMediaForm);
  $('social-media-refresh')?.addEventListener('click', () => loadSocialMedia(true).catch(error => showToast(error.message, 'error')));
  $('social-media-admin-list')?.addEventListener('click', async event => {
    const edit = event.target.closest('.social-edit'); const del = event.target.closest('.social-delete'); const id = (edit || del)?.dataset.id; if (!id) return;
    const item = socialMediaItems.find(row => String(row.id) === String(id)); if (!item) return;
    if (edit) { $('social-media-id').value=item.id; $('social-media-platform').value=item.platform; $('social-media-name').value=item.name || ''; $('social-media-url').value=item.url || ''; $('social-media-role').value=item.role || 'AC Gang'; $('social-media-note').value=item.note || ''; $('social-media-image').value=item.image || ''; renderSocialImagePreview(item.image || ''); $('social-media-form').scrollIntoView({behavior:'smooth',block:'center'}); return; }
    if (!confirm(`Delete ${item.name || 'this channel'} from the public Media page?`)) return;
    try { await api(`/api/data/mediaLinks/${encodeURIComponent(id)}`, {method:'DELETE'}); await loadSocialMedia(true); showToast('Channel removed.', 'success'); } catch (error) { showToast(error.message, 'error'); }
  });

  async function loadSubmissions(){ const root=$('submission-admin-list'); if(!root || (!can('media:manage') && !can('admin:all')))return; try{ const data=await api('/api/submissions'); const items=data.items||[]; root.innerHTML=items.length?items.map(item=>`<article class=\"submission-card\"><div>${item.type==='gallery'?`<img src=\"${esc(assetUrl(item.url))}\" alt=\"Submitted photo\">`:`<video src=\"${esc(assetUrl(item.url))}\" controls preload=\"metadata\"></video>`}</div><div><span class=\"submission-status ${esc(item.status)}\">${esc(item.status)}</span><h3>${esc(item.originalName||item.title||'Upload')}</h3><p>Submitted by <strong>${esc(item.submitterName||item.submitterId||'Crew member')}</strong></p><small>${esc(new Date(item.createdAt||Date.now()).toLocaleString())}</small></div><div class=\"submission-actions\">${item.status==='pending'?`<button class=\"btn btn-red submission-review\" data-action=\"approve\" data-id=\"${esc(item.id)}\">ACCEPT</button><button class=\"btn btn-ghost submission-review\" data-action=\"reject\" data-id=\"${esc(item.id)}\">REJECT</button>`:`<span>${esc(item.status).toUpperCase()}</span>`}</div></article>`).join(''):'<div class=\"empty-state\">No upload requests yet.</div>'; }catch(error){root.innerHTML=`<div class=\"empty-state\">${esc(error.message)}</div>`;} }
  $('refresh-submissions')?.addEventListener('click',()=>loadSubmissions());
  $('submission-admin-list')?.addEventListener('click',async event=>{const btn=event.target.closest('.submission-review');if(!btn)return;btn.disabled=true;try{await api(`/api/submissions/${encodeURIComponent(btn.dataset.id)}/review`,{method:'POST',body:JSON.stringify({action:btn.dataset.action})});showToast(`Submission ${btn.dataset.action==='approve'?'accepted':'rejected'}.`,'success');await loadSubmissions();}catch(error){btn.disabled=false;showToast(error.message||'Review failed.','error');}});

  // Integrated backend: OAuth session, Discord role sync, announcements, tickets and audit logs.
  async function loadBackendState() {
    const status = $('backend-status');
    try {
      const data = await api('/api/auth/me');
      backendAvailable = true; authConfigured = Boolean(data.authConfigured); localPreviewMode = !authConfigured; currentUser = data.user; currentAccess = data.access || { permissions:[] }; botStatus = data.bot || { online:false };
      if (discordLogin) {
        const label = discordLogin.querySelector('span');
        if (label) label.textContent = currentUser ? `${currentUser.globalName || currentUser.username} · LOGOUT` : 'DISCORD LOGIN';
        discordLogin.title = currentUser ? `Logged in as ${currentUser.username}. Click to log out.` : 'Sign in with Discord';
      }
      if (status) { status.classList.toggle('is-online', botStatus.online); status.innerHTML = `<span class="status-dot"></span><span>Backend connected · Bot ${botStatus.online ? 'online' : 'offline'} · ${localPreviewMode ? 'OAuth not configured · local preview' : currentUser ? (data.access?.inGuild ? 'Discord member verified' : 'Not in configured Discord server') : 'Not signed in'}</span>`; }
      const notice = $('dashboard-access-notice');
      if (notice) notice.innerHTML = `<i class="fa-solid fa-shield-halved"></i><span>${currentUser ? `Signed in as ${esc(currentUser.globalName || currentUser.username)}. Permissions are verified by the backend.` : 'Sign in with Discord to access authorized management modules.'}</span>`;
      if (currentUser && can('settings:read')) {
        try { const settings = await api('/api/settings'); roleMappings = settings.roleMappings || {}; botSettingsCache = settings.botSettings || {}; save('roleMappings', roleMappings); renderRoleMappings(); renderBotSettings(settings.botSettings || {}); await loadDiscordConfigOptions(); renderRoleMappings(); renderBotSettings(settings.botSettings || {}); } catch (error) { if (error.status !== 403) console.warn(error); }
      }
      if (!currentUser && authConfigured && botStatus.online) await loadPublicMembers();
      loadPublishedContent('clips').catch(()=>{}); loadPublishedContent('gallery').catch(()=>{});
      if (currentUser && data.access?.inGuild) { await hydrateBackendCollections(); await loadPublicMembers(); if (can('members:read')) loadDiscordMembers().catch(()=>{}); if (can('tickets:manage') || can('admin:all')) loadTickets().catch(()=>{}); if (can('logs:read')) loadLogs().catch(()=>{}); if (can('media:manage') || can('admin:all')) loadSubmissions().catch(()=>{}); }
      applyUiPermissions(); renderRoute();
    } catch (_error) {
      backendAvailable = false; authConfigured = false; localPreviewMode = false; currentUser = null; currentAccess = { permissions:[] }; applyUiPermissions();
      if (status) { status.classList.remove('is-online'); status.innerHTML = '<span class="status-dot"></span><span>Backend offline · Local preview mode</span>'; }
      if (discordLogin) { const label = discordLogin.querySelector('span'); if (label) label.textContent = 'DISCORD LOGIN'; }
    }
  }
  function renderDiscordMembers(items = []) {
    const target = $('discord-members-grid'); if (!target) return;
    const roleSelect = $('discord-role-pick');
    const configured = Object.entries(roleMappings).filter(([key,value]) => value && (can('admin:all') || !['owner','boss','coboss'].includes(key)));
    if (roleSelect) roleSelect.innerHTML = configured.map(([key,value]) => `<option value="${esc(value)}">${esc(key)} · ${esc(value)}</option>`).join('');
    if (!items.length) { target.innerHTML = '<div class="empty-state">No synced Discord members found. Check the bot, guild ID, and Server Members intent.</div>'; return; }
    target.innerHTML = items.map(member => { const avatar = String(member.avatar || ''); const crispAvatar = avatar ? avatar.replace(/([?&]size=)\d+/i, '$1256') : ''; return `<article class="discord-member-card"><img src="${esc(crispAvatar)}" alt="" onerror="this.style.display='none'"><div class="discord-member-info"><strong>${esc(member.global_name || member.username)}</strong><small>@${esc(member.username)} · ${esc(member.user_id)}</small><div class="discord-role-tags"><span>${member.in_guild ? 'IN GUILD' : 'NOT IN GUILD'}</span>${(member.roleNames || []).map(role => `<span>${esc(role)}</span>`).join('') || '<span>No configured role</span>'}</div></div><div class="discord-member-actions"><button type="button" class="btn btn-ghost role-change" data-action="add" data-user="${esc(member.user_id)}" ${member.in_guild ? '' : 'disabled'}>ADD ROLE</button><button type="button" class="btn btn-ghost role-change" data-action="remove" data-user="${esc(member.user_id)}" ${member.in_guild ? '' : 'disabled'}>REMOVE ROLE</button></div></article>`; }).join('');
  }
  async function loadPublicMembers() {
    try {
      const data = await api('/api/public/members');
      if (!data.members) return;
      const savedMembers=read('members',[]); members = data.members.map(member => { const saved=savedMembers.find(row=>String(row.discordId||row.id)===String(member.user_id)); return { id:member.user_id, discordId:member.user_id, name:saved?.name || member.global_name || member.username, role:saved?.role || member.role, image:saved?.image || member.avatar || '', points:saved?.points || 0 }; });
      localStorage.setItem(KEY + 'members', JSON.stringify(members));
      renderMembers();
    } catch (_) { /* Public roster remains available in local preview if the API is unavailable. */ }
  }
  async function loadDiscordMembers() {
    const target = $('discord-members-grid'); if (target) target.innerHTML = '<div class="empty-state">Syncing Discord member roles…</div>';
    const data = await api(`/api/discord/members?q=${encodeURIComponent($('discord-member-search')?.value || '')}`); renderDiscordMembers(data.members || []);
  }
  $('discord-member-search')?.addEventListener('input', () => { clearTimeout(window.__anarchyMemberSearch); window.__anarchyMemberSearch = setTimeout(() => loadDiscordMembers().catch(error => showToast(error.message)), 300); });
  $('discord-members-grid')?.addEventListener('click', async event => {
    const button = event.target.closest('.role-change'); if (!button) return;
    const roleId = $('discord-role-pick')?.value; if (!roleId) return showToast('Configure at least one role ID in Settings first.');
    if (!confirm(`${button.dataset.action === 'add' ? 'Add' : 'Remove'} the selected role for this member?`)) return;
    try { await api(`/api/discord/members/${button.dataset.user}/roles`, { method:'POST', body:JSON.stringify({ roleId, action:button.dataset.action }) }); await loadDiscordMembers(); showToast('Discord role updated.'); }
    catch (error) { showToast(error.message); }
  });
  function addAnnouncementField(name = '', value = '', inline = false) {
    const container = $('announcement-fields'); if (!container || container.children.length >= 25) return showToast('Discord embeds support up to 25 fields.');
    const row = document.createElement('div'); row.className = 'announcement-field-row';
    row.innerHTML = `<input class="embed-field-name" maxlength="256" placeholder="Field name" value="${esc(name)}"><input class="embed-field-value" maxlength="1024" placeholder="Field value" value="${esc(value)}"><label class="embed-inline-toggle"><input class="embed-field-inline" type="checkbox" ${inline ? 'checked' : ''}> Inline</label><button class="icon-action remove-embed-field" type="button" aria-label="Remove embed field" title="Remove field">${trashIcon}</button>`;
    container.append(row); row.querySelectorAll('input').forEach(input => input.addEventListener('input', updateAnnouncementPreview));
    row.querySelector('.remove-embed-field').addEventListener('click', () => { row.remove(); updateAnnouncementPreview(); });
    updateAnnouncementPreview();
  }
  $('add-announcement-field')?.addEventListener('click', () => addAnnouncementField());
  const announcementFields = ['announcement-author','announcement-author-icon','announcement-title','announcement-url','announcement-description','announcement-footer','announcement-thumbnail','announcement-image','announcement-color','announcement-timestamp'];
  function formatDiscordMarkdown(value='') { return esc(value).replace(/\*\*(.+?)\*\*/gs,'<strong>$1</strong>').replace(/\*(?!\*)(.+?)\*(?!\*)/gs,'<em>$1</em>').replace(/`([^`]+)`/g,'<code>$1</code>'); }
  function updateAnnouncementPreview() {
    const title = $('announcement-title')?.value.trim(); const description = $('announcement-description')?.value.trim(); const footer = $('announcement-footer')?.value.trim(); const thumb = $('announcement-thumbnail')?.value.trim(); const image = $('announcement-image')?.value.trim();
    if ($('announcement-preview-title')) $('announcement-preview-title').textContent = title || 'Announcement title';
    if ($('announcement-preview-description')) $('announcement-preview-description').innerHTML = formatDiscordMarkdown(description || 'Your message preview will appear here.');
    if ($('announcement-preview-footer')) $('announcement-preview-footer').textContent = footer || 'ANARCHY • Official notice';
    const card = $('announcement-preview'); if (card) card.style.borderLeftColor = $('announcement-color')?.value || '#ed2434';
    const author = $('announcement-preview-author'); if (author) { const authorName=$('announcement-author')?.value.trim() || ''; const authorIcon=$('announcement-author-icon')?.value.trim() || ''; author.innerHTML = `${authorIcon && /^https:\/\//i.test(authorIcon) ? `<img class=\"embed-author-icon\" src=\"${esc(authorIcon)}\" alt=\"\">` : ''}${authorName ? `<span>${esc(authorName)}</span>` : ''}`; }
    const t = $('announcement-preview-thumb'); if (t) { t.innerHTML = ''; if (thumb && /^https:\/\//i.test(thumb)) { const img = document.createElement('img'); img.src = thumb; img.alt = ''; t.append(img); } }
    const i = $('announcement-preview-image'); if (i) { i.classList.toggle('hidden', !(image && /^https:\/\//i.test(image))); if (image && /^https:\/\//i.test(image)) i.src = image; }
    const fieldsTarget = $('announcement-preview-fields'); if (fieldsTarget) { const rows=[...($('announcement-fields')?.querySelectorAll('.announcement-field-row') || [])].map(row => { const name=row.querySelector('.embed-field-name').value.trim(); const value=row.querySelector('.embed-field-value').value.trim(); const inline=row.querySelector('.embed-field-inline').checked; return name && value ? `<div class=\"embed-preview-field ${inline?'is-inline':''}\"><strong>${formatDiscordMarkdown(name)}</strong><span>${formatDiscordMarkdown(value)}</span></div>` : ''; }).join(''); fieldsTarget.innerHTML=rows; }
    const url = $('announcement-url')?.value.trim(); if ($('announcement-preview-title')) $('announcement-preview-title').title = url || '';
  }
  announcementFields.forEach(id => $(id)?.addEventListener('input', updateAnnouncementPreview));
  async function uploadImageFile(file, targetId) { if (!file || !file.type.startsWith('image/')) return; if (!backendAvailable || !currentUser) { showToast('سجّل دخولك وشغّل الـ Backend لرفع صورة مشتركة.'); return; } const form = new FormData(); form.append('image', file); const result = await api('/api/uploads/image', { method:'POST', body:form }); const url = `${API_BASE}${result.url}`; $(targetId).value = url; $(targetId).dispatchEvent(new Event('input', { bubbles:true })); const preview = document.querySelector(`[data-image-preview="${targetId}"]`); if (preview) preview.innerHTML = `<img src="${esc(url)}" alt="معاينة الصورة"><button type="button" class="btn btn-ghost image-clear">إزالة</button>`; preview?.querySelector('.image-clear')?.addEventListener('click', () => { $(targetId).value=''; $(targetId).dispatchEvent(new Event('input',{bubbles:true})); preview.innerHTML=''; }); }
  document.querySelectorAll('[data-image-browse]').forEach(button => button.addEventListener('click', () => document.querySelector(`[data-image-target="${button.dataset.imageBrowse}"]`)?.click()));
  document.querySelectorAll('[data-image-target]').forEach(input => input.addEventListener('change', async () => { try { await uploadImageFile(input.files?.[0], input.dataset.imageTarget); } catch (error) { showToast(error.message || 'فشل رفع الصورة.'); } finally { input.value=''; } }));
  document.addEventListener('paste', async event => { if (!location.hash.includes('announcements')) return; const imageItem = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/')); if (!imageItem) return; const active = document.activeElement; const targetId = active?.id === 'announcement-thumbnail' ? 'announcement-thumbnail' : 'announcement-image'; try { await uploadImageFile(imageItem.getAsFile(), targetId); showToast('تم رفع الصورة الملصوقة.'); } catch (error) { showToast(error.message || 'فشل رفع الصورة الملصوقة.'); } });
  $('announcement-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const fields = [...$('announcement-fields').querySelectorAll('.announcement-field-row')].map(row => ({ name:row.querySelector('.embed-field-name').value.trim(), value:row.querySelector('.embed-field-value').value.trim(), inline:row.querySelector('.embed-field-inline').checked })).filter(field => field.name && field.value);
    try { await api('/api/announcements/send', { method:'POST', body:JSON.stringify({ channelId:$('announcement-channel').value.trim(), authorName:$('announcement-author').value.trim(), authorIcon:$('announcement-author-icon').value.trim(), title:$('announcement-title').value.trim(), url:$('announcement-url').value.trim(), description:$('announcement-description').value.trim(), color:$('announcement-color').value, thumbnail:$('announcement-thumbnail').value.trim(), image:$('announcement-image').value.trim(), footer:$('announcement-footer').value.trim(), timestamp:$('announcement-timestamp').checked, fields }) }); showToast('Announcement sent to Discord.','success'); event.target.reset(); $('announcement-color').value = '#ed2434'; $('announcement-fields').innerHTML = ''; addAnnouncementField(); updateAnnouncementPreview(); }
    catch (error) { showToast(error.message); }
  });
  async function loadTickets() {
    const target = $('tickets-list'); if (!target) return;
    try { const data = await api('/api/tickets'); const canManage = can('tickets:manage') || can('admin:all');
      target.innerHTML = (data.tickets || []).map(ticket => `<article class="ticket-card"><div><span class="ticket-number">${esc(ticket.ticket_number)}</span><span class="ticket-status status-${esc(ticket.status)}">${esc(ticket.status)}</span><h3>${esc(ticket.subject)}</h3><p>${esc(ticket.category)} · Owner <code>${esc(ticket.owner_id)}</code></p><small>Updated ${esc(new Date(ticket.updated_at).toLocaleString())}</small></div><div class="ticket-actions"><button class="btn btn-ghost ticket-view" data-id="${esc(ticket.ticket_number)}">VIEW / REPLY</button>${canManage && ticket.status === 'open' ? `<button class="btn btn-ghost ticket-action" data-action="claim" data-id="${esc(ticket.ticket_number)}">CLAIM</button>` : ''}${canManage && ticket.status !== 'closed' ? `<button class="btn btn-ghost ticket-action" data-action="close" data-id="${esc(ticket.ticket_number)}">CLOSE</button>` : ''}${canManage && ticket.status === 'closed' ? `<button class="btn btn-ghost ticket-action" data-action="reopen" data-id="${esc(ticket.ticket_number)}">REOPEN</button>` : ''}</div></article>`).join('') || '<div class="empty-state">No tickets yet.</div>';
    } catch (error) { target.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; }
  }
  $('ticket-open-form')?.addEventListener('submit', async event => { event.preventDefault(); try { const data = await api('/api/tickets', { method:'POST', body:JSON.stringify({ subject:$('ticket-subject').value, category:$('ticket-category').value, message:$('ticket-message').value }) }); event.target.reset(); await loadTickets(); showToast(`Ticket ${data.ticketNumber} created.`); } catch (error) { showToast(error.message); } });
  $('refresh-tickets')?.addEventListener('click', () => loadTickets().catch(error => showToast(error.message)));
  $('tickets-list')?.addEventListener('click', async event => { const button = event.target.closest('.ticket-action'); if (!button) return; try { await api(`/api/tickets/${button.dataset.id}`, { method:'PATCH', body:JSON.stringify({ action:button.dataset.action }) }); await loadTickets(); showToast(`Ticket ${button.dataset.action} successful.`); } catch (error) { showToast(error.message); } });
  $('tickets-list')?.addEventListener('click', async event => { const button = event.target.closest('.ticket-view'); if (!button) return; const card = button.closest('.ticket-card'); let panel = card.querySelector('.ticket-conversation'); if (panel) { panel.remove(); return; } try { const data = await api(`/api/tickets/${button.dataset.id}/messages`); panel = document.createElement('div'); panel.className = 'ticket-conversation'; panel.innerHTML = `<div class="ticket-message-list">${(data.messages || []).map(message => `<div class="ticket-message"><strong>${esc(message.author_name)}</strong><small>${esc(new Date(message.created_at).toLocaleString())}</small><p>${esc(message.body)}</p></div>`).join('')}</div>${data.ticket.status !== 'closed' ? `<form class="ticket-reply-form" data-id="${esc(button.dataset.id)}"><textarea name="message" required maxlength="4000" rows="2" placeholder="Write a reply…"></textarea><button class="btn btn-red" type="submit">SEND REPLY</button></form>` : '<small>This ticket is closed.</small>'}`; card.append(panel); } catch (error) { showToast(error.message); } });
  $('tickets-list')?.addEventListener('submit', async event => { const form = event.target.closest('.ticket-reply-form'); if (!form) return; event.preventDefault(); const input = form.querySelector('[name=message]'); try { await api(`/api/tickets/${form.dataset.id}/messages`, { method:'POST', body:JSON.stringify({ message:input.value }) }); await loadTickets(); showToast('Reply sent. Open the ticket to view the updated conversation.'); } catch (error) { showToast(error.message); } });
  async function loadClockData() {
    const summary = $('clock-summary'); const recent = $('clock-recent-list');
    const data = await api('/api/clock/shifts');
    if (summary) summary.innerHTML = `<div class="clock-stat"><strong>${(data.active || []).length}</strong><span>ACTIVE SHIFTS</span></div><div class="clock-stat"><strong>${(data.recent || []).length}</strong><span>RECENT RECORDS</span></div>`;
    if (recent) recent.innerHTML = (data.recent || []).map(shift => `<article class="log-row"><div class="log-mark ${shift.ended_at ? '' : 'is-failed'}"></div><div class="log-main"><strong>${shift.ended_at ? 'Shift completed' : 'Active shift'}</strong><small>Discord ID ${esc(shift.user_id)} · ${esc(shift.start_source || 'unknown source')}</small><p>Started ${esc(new Date(shift.started_at).toLocaleString())}${shift.ended_at ? ` · Ended ${esc(new Date(shift.ended_at).toLocaleString())} · ${Math.floor((shift.duration_seconds || 0)/3600)}h ${Math.floor(((shift.duration_seconds || 0)%3600)/60)}m` : ` · Running for ${Math.floor((Date.now()-shift.started_at)/3600000)}h`}</p></div></article>`).join('') || '<div class="empty-state">No shifts recorded yet.</div>';
  }
  $('refresh-clock')?.addEventListener('click', () => loadClockData().catch(error => showToast(error.message)));
  $('clock-adjust-form')?.addEventListener('submit', async event => { event.preventDefault(); try { const result = await api('/api/clock/adjust', { method:'POST', body:JSON.stringify({ userId:$('clock-user-id').value.trim(), minutes:Number($('clock-adjust-minutes').value), period:$('clock-adjust-period').value, reason:$('clock-adjust-reason').value.trim() }) }); event.target.reset(); await loadClockData(); showToast(`Time adjusted by ${result.minutes} minutes. The action was logged.`); } catch (error) { showToast(error.message); } });

  async function loadLogs() {
    const target = $('logs-list'); if (!target) return;
    try { const filter = $('logs-filter')?.value || ''; const data = await api(`/api/logs?limit=150&action=${encodeURIComponent(filter)}`); target.innerHTML = (data.logs || []).map(log => `<article class="log-row"><div class="log-mark ${log.result === 'success' ? '' : 'is-failed'}"></div><div class="log-main"><strong>${esc(log.action)}</strong><small>${esc(log.actor_name || log.actor_id || 'System')} · ${esc(log.target_type || 'system')} ${esc(log.target_id || '')}</small><p>${esc(JSON.stringify(log.details || {}))}</p></div><time>${esc(new Date(log.created_at).toLocaleString())}</time></article>`).join('') || '<div class="empty-state">No matching audit logs.</div>'; }
    catch (error) { target.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; }
  }
  $('refresh-logs')?.addEventListener('click', () => loadLogs().catch(error => showToast(error.message)));
  $('apply-logs-filter')?.addEventListener('click', () => loadLogs().catch(error => showToast(error.message)));

  $('year').textContent = new Date().getFullYear();
  if (!location.hash) history.replaceState(null,'','#home');
  renderRoute(); renderMembers(); renderTasks(); renderResources(); renderGuns(); renderRoleMappings(); renderLeaderboard(); addAnnouncementField(); updateAnnouncementPreview(); loadBackendState();
})();
