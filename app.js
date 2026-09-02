/** ===================================================================
 *  POS Multi-Store — frontend logic
 *  Talks to a Google Apps Script Web App (see Code.gs / README.md).
 * =================================================================== */

// PASTE your Apps Script Web App exec URL here after deploying Code.gs
const GAS_URL = 'https://script.google.com/macros/s/AKfycbw15_BLcS1bhAmZSjH-gJc87J0I050InI_8BPk2PbMyG6B-1iuxdmlmv1FYlRPUs6CI/exec';

const state = {
  clientId: null,
  user: null,       // { client_id, name, permission }
  stores: [],
  currentStore: null,
  inventory: [],
  invById: {},      // item_id -> inventory row (has bundle_group / bundle_price)
  couriers: [],
  customers: [],      // customer directory, loaded once per session (see ensureCustomersLoaded)
  cart: {},          // item_id -> { item_name, price, qty }
  orders: [],        // order history of the store currently open (newest first)
  historyScope: 'all', // 'all' = everyone's orders in this store, 'mine' = this device only
  lastSubmit: null,  // payload of the last save attempt, kept so a failed save can be retried safely
  pendingCourier: null,
  pendingCustomer: null,       // customer row picked from suggestions in the checkout popup, or null
  pendingCustomerFields: null, // resolved customer_* fields for the order about to be submitted
  pendingAvatar: null, // { base64, mime } chosen in the "new user" modal, before registering
};

/* ---------------- Client ID (identifies this browser/device) ---------------- */
function getOrCreateClientId() {
  let id = localStorage.getItem('pos_client_id');
  if (!id) {
    id = 'CID-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('pos_client_id', id);
  }
  return id;
}

/* ---------------- API helpers ---------------- */
async function apiGet(action, params) {
  const url = new URL(GAS_URL);
  url.searchParams.set('action', action);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return res.json();
}

async function apiPost(action, payload) {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    // text/plain avoids a CORS preflight against Apps Script
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload }),
  });
  return res.json();
}

/* ---------------- Toast ---------------- */
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------------- Page routing ---------------- */
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ---------------- Init / identify user ---------------- */
async function init() {
  state.clientId = getOrCreateClientId();

  try {
    const { user } = await apiGet('getUser', { client_id: state.clientId });
    if (user) {
      state.user = user;
      renderProfile();
    } else {
      openNewUserModal();
    }
  } catch (err) {
    showToast('เชื่อมต่อ Google Sheet ไม่สำเร็จ ตรวจสอบ GAS_URL ใน app.js');
    console.error(err);
  }

  loadStores();
  loadCourierEarnings();
  bindEvents();
}

/* ---------------- Courier commission summary (shop_a only) ----------------
 * Purely additive/read-only: a separate API call + a separate DOM section,
 * doesn't touch the store-picker or order-entry flow at all. If the call
 * fails for any reason the panel just silently stays hidden. */
async function loadCourierEarnings() {
  try {
    const { earnings } = await apiGet('getCourierEarnings');
    renderCourierEarnings(earnings || []);
  } catch (err) {
    console.warn('courier earnings unavailable', err);
  }
}

function renderCourierEarnings(earnings) {
  const panel = document.getElementById('courier-earnings');
  const linesEl = document.getElementById('courier-earnings-lines');
  if (!earnings.length) {
    panel.hidden = true;
    return;
  }
  linesEl.innerHTML = earnings.map(e => `
    <div class="courier-earnings-line">
      <span class="courier-earnings-name">${e.courier}</span>
      <span class="courier-earnings-amt">${e.total.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</span>
      <button class="courier-reset-btn" data-courier="${e.courier}">จ่ายแล้ว/รีเซ็ต</button>
    </div>
  `).join('');
  panel.hidden = false;
}

async function resetCourierEarnings(courierName) {
  const ok = confirm(`ยืนยันว่าจ่ายค่าส่งให้ "${courierName}" แล้ว?\nยอดคงเหลือของคนส่งคนนี้จะรีเซ็ตเป็น 0.- (ออเดอร์เก่ายังอยู่ในชีตครบ ไม่มีอะไรถูกลบ)`);
  if (!ok) return;

  try {
    const res = await apiPost('resetCourierEarnings', { courier: courierName });
    if (res.ok) {
      showToast(`รีเซ็ตยอดของ ${courierName} แล้ว`);
      loadCourierEarnings();
    } else {
      showToast('รีเซ็ตไม่สำเร็จ: ' + res.error);
    }
  } catch (err) {
    showToast('รีเซ็ตไม่สำเร็จ ตรวจสอบการเชื่อมต่อ');
    console.error(err);
  }
}

function renderProfile() {
  document.getElementById('profile-name').textContent = state.user.name;
  document.getElementById('profile-permission').textContent = state.user.permission;
  const avatarEl = document.getElementById('profile-avatar');
  avatarEl.style.backgroundImage = state.user.avatar_url ? `url("${state.user.avatar_url}")` : '';
}

function openNewUserModal() {
  document.getElementById('modal-newuser').classList.add('active');
}

async function confirmNewUser() {
  const name = document.getElementById('input-username').value.trim();
  if (!name) return;
  const payload = { client_id: state.clientId, name, permission: 'Staff' };
  if (state.pendingAvatar) {
    payload.avatar_base64 = state.pendingAvatar.base64;
    payload.avatar_mime = state.pendingAvatar.mime;
  }
  const { user } = await apiPost('registerUser', payload);
  state.user = user;
  renderProfile();
  document.getElementById('modal-newuser').classList.remove('active');
}

/* ---------------- Profile / avatar photo picking ---------------- */

/** Downscales + compresses a chosen photo client-side before upload, so avatar
 * uploads stay fast on mobile data (phone photos can be several MB otherwise). */
// Small on purpose: the photo is now stored as a data: URI directly inside a
// Google Sheets cell (see README/Code.gs), which has a ~50,000 character limit
// per cell — 280px keeps the base64 string comfortably under that with margin.
function resizeImageFile(file, maxDim = 280, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > height) {
          if (width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        } else if (height > maxDim) {
          width = Math.round(width * (maxDim / height)); height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ base64: dataUrl.split(',')[1], mime: 'image/jpeg' });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleNewAvatarChosen(file) {
  if (!file) return;
  const resized = await resizeImageFile(file);
  state.pendingAvatar = resized;
  document.getElementById('new-avatar-preview').style.backgroundImage = `url("data:${resized.mime};base64,${resized.base64}")`;
}

async function handleExistingAvatarChosen(file) {
  if (!file || !state.user) return;
  showToast('กำลังอัพโหลดรูป...');
  try {
    const resized = await resizeImageFile(file);
    const { user } = await apiPost('registerUser', {
      client_id: state.clientId,
      name: state.user.name,
      permission: state.user.permission,
      avatar_base64: resized.base64,
      avatar_mime: resized.mime,
    });
    state.user = user;
    renderProfile();
    showToast('เปลี่ยนรูปโปรไฟล์แล้ว');
  } catch (err) {
    showToast('อัพโหลดรูปไม่สำเร็จ');
    console.error(err);
  }
}

/* ---------------- Store picker (Page A) ---------------- */
async function loadStores() {
  try {
    const { stores } = await apiGet('getStores');
    state.stores = stores || [];
    renderStoreGrid();
  } catch (err) {
    console.error(err);
  }
}

function renderStoreGrid() {
  const grid = document.getElementById('store-grid');
  grid.innerHTML = '';
  state.stores.forEach(store => {
    const tile = document.createElement('button');
    tile.className = 'store-tile';
    const logoStyle = store.logo_url
      ? `background-image:url('${store.logo_url}')`
      : `background:${store.color || '#8B7FD6'}`;
    tile.innerHTML = `
      <div class="store-logo" style="${logoStyle}">${store.logo_url ? '' : (store.logo_emoji || '')}</div>
      <div class="store-name">${store.name}</div>
    `;
    tile.addEventListener('click', () => openStore(store));
    grid.appendChild(tile);
  });
}

/* ---------------- Order entry (Page B) ---------------- */
async function openStore(store) {
  state.currentStore = store;
  state.cart = {};
  document.getElementById('order-store-name').textContent = store.name;
  document.getElementById('order-user-name').textContent = state.user ? state.user.name : '';
  showPage('page-order');

  try {
    const { items } = await apiGet('getInventory', { store_id: store.store_id });
    state.inventory = items || [];
    state.invById = {};
    state.inventory.forEach(i => (state.invById[i.item_id] = i));
    renderProductGrid();
    renderSummary();
  } catch (err) {
    showToast('โหลดสินค้าไม่สำเร็จ');
    console.error(err);
  }
}

function renderProductGrid() {
  const grid = document.getElementById('product-grid');
  grid.innerHTML = '';
  state.inventory.forEach(item => {
    const tile = document.createElement('div');
    tile.className = 'product-tile';
    const boxStyle = item.image_url ? ` style="background-image:url('${item.image_url}')"` : '';
    tile.innerHTML = `
      <div class="product-box" data-id="${item.item_id}"${boxStyle}>
        <div class="product-qty-badge">0</div>
      </div>
      <div class="product-name">${item.item_name}</div>
      <div class="product-price">${item.price}.-</div>
      <div class="product-stepper">
        <button class="stepper-btn" data-action="dec" data-id="${item.item_id}">−</button>
        <span class="stepper-qty" data-qty-for="${item.item_id}">0</span>
        <button class="stepper-btn" data-action="inc" data-id="${item.item_id}">+</button>
      </div>
    `;
    grid.appendChild(tile);
  });
}

function changeQty(itemId, delta) {
  const item = state.inventory.find(i => i.item_id === itemId);
  if (!item) return;
  const current = state.cart[itemId]?.qty || 0;
  const next = Math.max(0, current + delta);

  if (next === 0) {
    delete state.cart[itemId];
  } else {
    state.cart[itemId] = { item_id: itemId, item_name: item.item_name, price: Number(item.price), qty: next };
  }

  // update product box UI
  const box = document.querySelector(`.product-box[data-id="${itemId}"]`);
  const badge = box.querySelector('.product-qty-badge');
  box.classList.toggle('selected', next > 0);
  badge.textContent = next;
  document.querySelector(`[data-qty-for="${itemId}"]`).textContent = next;

  renderSummary();
}

/* ---------------- Bundle pricing (mirrors Code.gs so the on-screen total
 * matches exactly what gets saved to the sheet) ---------------- */
function calcBundleTotal(qty, singlePrice, bundlePrice) {
  if (!bundlePrice) return qty * singlePrice;
  const bundles = Math.floor(qty / 3);
  const rem = qty % 3;
  return bundles * bundlePrice + rem * singlePrice;
}

function calcLineTotals(items, invById) {
  const groups = {}; // key -> { qty, indices, singlePrice, bundlePrice }

  items.forEach((it, idx) => {
    const inv = invById[String(it.item_id)] || {};
    const singlePrice = Number(it.price || 0);
    const bundleGroup = inv.bundle_group ? String(inv.bundle_group) : '';
    const bundlePrice = bundleGroup ? Number(inv.bundle_price || 0) : 0;
    const key = bundleGroup || ('__single__' + it.item_id);

    if (!groups[key]) groups[key] = { qty: 0, indices: [], singlePrice, bundlePrice };
    groups[key].qty += Number(it.qty || 0);
    groups[key].indices.push(idx);
  });

  const lineTotals = new Array(items.length).fill(0);

  Object.keys(groups).forEach(key => {
    const g = groups[key];
    const groupTotal = calcBundleTotal(g.qty, g.singlePrice, g.bundlePrice);
    let allocated = 0;
    g.indices.forEach((idx, i) => {
      const qty = Number(items[idx].qty || 0);
      let lt;
      if (i === g.indices.length - 1) {
        lt = Number((groupTotal - allocated).toFixed(2));
      } else {
        lt = Number(((groupTotal * qty) / g.qty).toFixed(2));
        allocated += lt;
      }
      lineTotals[idx] = lt;
    });
  });

  return lineTotals;
}

function renderSummary() {
  const linesEl = document.getElementById('summary-lines');
  const items = Object.values(state.cart);

  if (items.length === 0) {
    linesEl.innerHTML = '<div class="summary-empty">ยังไม่ได้เลือกสินค้า</div>';
    document.getElementById('summary-total').textContent = 0;
    return;
  }

  const lineTotals = calcLineTotals(items, state.invById);

  linesEl.innerHTML = items.map((it, i) => `
    <div class="summary-line">
      <span class="summary-line-name">${it.item_name} x${it.qty}</span>
      <span class="summary-line-amt">${lineTotals[i]}.-</span>
    </div>
  `).join('');

  const total = lineTotals.reduce((s, v) => s + v, 0);
  document.getElementById('summary-total').textContent = total;
}

/* ---------------- Save order -> pick courier -> submit ---------------- */
function openCourierModal() {
  const items = Object.values(state.cart);
  if (items.length === 0) {
    showToast('กรุณาเลือกสินค้าก่อน');
    return;
  }
  resetCustomerSection();
  ensureCustomersLoaded();
  renderCourierOptions();
  document.getElementById('modal-courier').classList.add('active');
}

/* ---------------- Customer search (inside the checkout popup) ----------------
 * Typing a name/phone that matches a row in the Customers sheet auto-fills
 * address/phone/note (read-only card, "เปลี่ยน" to search again). Typing one
 * that doesn't match offers an optional "+ เพิ่มที่อยู่/เบอร์โทร/หมายเหตุ" - left
 * collapsed, this is just a walk-in order with a name and nothing else saved. */
async function ensureCustomersLoaded() {
  if (state.customers.length) return;
  try {
    const { customers } = await apiGet('getCustomers');
    state.customers = customers || [];
  } catch (err) {
    console.warn('customers unavailable', err);
  }
}

function resetCustomerSection() {
  state.pendingCustomer = null;
  state.pendingCustomerFields = null;

  const search = document.getElementById('customer-search');
  search.value = '';
  search.disabled = false;

  document.getElementById('customer-suggestions').hidden = true;
  document.getElementById('customer-suggestions').innerHTML = '';
  document.getElementById('customer-picked-card').hidden = true;
  document.getElementById('customer-new-hint').hidden = true;
  document.getElementById('customer-new-fields').hidden = true;
  document.getElementById('customer-new-phone').value = '';
  document.getElementById('customer-new-address').value = '';
  document.getElementById('customer-new-note').value = '';
  document.getElementById('customer-new-save').checked = true;
}

function filterCustomers(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return state.customers.filter(c =>
    String(c.name || '').toLowerCase().includes(q) ||
    String(c.phone || '').includes(q)
  ).slice(0, 8);
}

function renderCustomerSuggestions() {
  if (state.pendingCustomer) return; // locked onto a picked customer - typing is disabled anyway

  const search = document.getElementById('customer-search');
  const wrap = document.getElementById('customer-suggestions');
  const hint = document.getElementById('customer-new-hint');
  const query = search.value;

  if (!query.trim()) {
    wrap.hidden = true;
    hint.hidden = true;
    return;
  }

  const matches = filterCustomers(query);
  if (matches.length) {
    wrap.hidden = false;
    hint.hidden = true;
    wrap.innerHTML = matches.map(c => `
      <button type="button" class="customer-suggestion-item">
        <span class="cs-name">${escapeHtml(c.name)}</span>
        ${c.phone ? `<span class="cs-phone">${escapeHtml(String(c.phone))}</span>` : ''}
      </button>
    `).join('');
    wrap.querySelectorAll('.customer-suggestion-item').forEach((btn, i) => {
      // mousedown (not click) fires before the input's blur handler hides the list
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickCustomer(matches[i]);
      });
    });
  } else {
    wrap.hidden = true;
    wrap.innerHTML = '';
    hint.hidden = false;
  }
}

function pickCustomer(cust) {
  state.pendingCustomer = cust;

  const search = document.getElementById('customer-search');
  search.value = cust.name;
  search.disabled = true;

  document.getElementById('customer-suggestions').hidden = true;
  document.getElementById('customer-new-hint').hidden = true;
  document.getElementById('customer-new-fields').hidden = true;

  const card = document.getElementById('customer-picked-card');
  card.hidden = false;
  document.getElementById('customer-picked-name').textContent = cust.name;

  const phoneEl = document.getElementById('customer-picked-phone');
  phoneEl.textContent = cust.phone ? `โทร: ${cust.phone}` : '';
  phoneEl.hidden = !cust.phone;

  const addrEl = document.getElementById('customer-picked-address');
  addrEl.textContent = cust.address ? `ที่อยู่: ${cust.address}` : '';
  addrEl.hidden = !cust.address;

  const noteEl = document.getElementById('customer-picked-note');
  noteEl.textContent = cust.note ? `หมายเหตุ: ${cust.note}` : '';
  noteEl.hidden = !cust.note;
}

function clearPickedCustomer() {
  state.pendingCustomer = null;
  const search = document.getElementById('customer-search');
  search.disabled = false;
  search.value = '';
  document.getElementById('customer-picked-card').hidden = true;
  search.focus();
}

/** Reads the checkout popup's customer section into the fields submitOrder
 * needs. { valid: false } if the required name is blank - the caller shows
 * a toast and keeps the popup open rather than saving an order with nobody
 * attached to it. */
function readCustomerFormState() {
  const name = document.getElementById('customer-search').value.trim();
  if (!name) return { valid: false };

  if (state.pendingCustomer) {
    const c = state.pendingCustomer;
    return {
      valid: true,
      fields: {
        customer_id: c.customer_id || '',
        customer_name: c.name || name,
        customer_phone: c.phone || '',
        customer_address: c.address || '',
        customer_note: c.note || '',
        save_customer: false, // already in the Customers sheet - nothing new to save
      },
    };
  }

  const fieldsOpen = !document.getElementById('customer-new-fields').hidden;
  return {
    valid: true,
    fields: {
      customer_id: '',
      customer_name: name,
      customer_phone: fieldsOpen ? document.getElementById('customer-new-phone').value.trim() : '',
      customer_address: fieldsOpen ? document.getElementById('customer-new-address').value.trim() : '',
      customer_note: fieldsOpen ? document.getElementById('customer-new-note').value.trim() : '',
      save_customer: fieldsOpen ? document.getElementById('customer-new-save').checked : false,
    },
  };
}

async function renderCourierOptions() {
  const wrap = document.getElementById('courier-options');
  wrap.innerHTML = '<div class="modal-sub">กำลังโหลด...</div>';
  if (!state.couriers.length) {
    try {
      const { couriers } = await apiGet('getCouriers');
      state.couriers = couriers || [];
    } catch (err) {
      console.error(err);
    }
  }
  state.pendingCourier = null;
  wrap.innerHTML = '';
  state.couriers.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'courier-btn';
    btn.textContent = c.name;
    btn.dataset.id = c.courier_id;
    btn.addEventListener('click', () => {
      const customerForm = readCustomerFormState();
      if (!customerForm.valid) {
        showToast('กรุณาใส่ชื่อลูกค้าก่อนเลือกผู้จัดส่ง');
        document.getElementById('customer-search').focus();
        return;
      }
      state.pendingCourier = c.name;
      state.pendingCustomerFields = customerForm.fields;
      wrap.querySelectorAll('.courier-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      submitOrder();
    });
    wrap.appendChild(btn);
  });
}

/** A one-off id for each save attempt. If the connection drops halfway, the
 * retry carries the SAME id, and the backend recognises it and reports the
 * already-saved order instead of writing a second copy. */
function newClientUid() {
  return 'U-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function submitOrder(retryPayload) {
  document.getElementById('modal-courier').classList.remove('active');

  const payload = retryPayload || Object.assign({
    store_id: state.currentStore.store_id,
    client_id: state.clientId,
    user_name: state.user ? state.user.name : '',
    items: Object.values(state.cart),
    courier: state.pendingCourier,
    client_uid: newClientUid(),
  }, state.pendingCustomerFields || {});
  state.lastSubmit = payload;

  const btn = document.getElementById('btn-save-order');
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'กำลังบันทึก...';

  try {
    const res = await apiPost('submitOrder', payload);
    if (res.ok) {
      state.lastSubmit = null;
      state.cart = {};
      renderProductGrid();
      renderSummary();
      loadCourierEarnings();
      showResultModal(true, res, payload);
    } else {
      showResultModal(false, res, payload);
    }
  } catch (err) {
    console.error(err);
    showResultModal(false, { error: 'เชื่อมต่ออินเทอร์เน็ตไม่ได้' }, payload);
  } finally {
    btn.disabled = false;
    btn.textContent = btnLabel;
  }
}

/* ---------------- Save result modal ----------------
 * Replaces the old toast-only feedback: a save is never ambiguous again — it
 * either shows a green tick with the order id/total that landed in the sheet,
 * or a red cross with a retry button that re-sends the SAME order (no
 * duplicate risk, see newClientUid / client_uid in Code.gs). */
function showResultModal(ok, res, payload) {
  const modal = document.getElementById('modal-result');
  const icon = document.getElementById('result-icon');
  const title = document.getElementById('result-title');
  const sub = document.getElementById('result-sub');
  const detail = document.getElementById('result-detail');
  const retryBtn = document.getElementById('btn-result-retry');

  icon.textContent = ok ? '✓' : '✕';
  icon.className = 'result-icon ' + (ok ? 'ok' : 'fail');
  retryBtn.hidden = ok;

  if (ok) {
    title.textContent = res.duplicate ? 'ออเดอร์นี้บันทึกไว้แล้ว' : 'บันทึกออเดอร์สำเร็จ';
    sub.textContent = res.duplicate
      ? 'ระบบตรวจพบว่าออเดอร์เดิมเข้าชีตไปเรียบร้อยแล้ว จึงไม่บันทึกซ้ำ'
      : 'ข้อมูลเข้า Google Sheet เรียบร้อยแล้ว';
    const customerName = res.customer_name || payload.customer_name || '';
    detail.innerHTML = `
      ${customerName ? `<div class="result-line"><span>ลูกค้า</span><b>${escapeHtml(customerName)}</b></div>` : ''}
      <div class="result-line"><span>ยอดรวม</span><b>${res.total} บาท</b></div>
      <div class="result-line"><span>คนส่ง</span><b>${escapeHtml(payload.courier || '-')}</b></div>
      <div class="result-line"><span>เวลา</span><b>${escapeHtml(res.timestamp || nowLocalString())}</b></div>
      <div class="result-line"><span>เลขที่</span><b>${escapeHtml(String(res.order_id || '-'))}</b></div>
    `;
  } else {
    title.textContent = 'บันทึกไม่สำเร็จ';
    sub.textContent = 'ออเดอร์ยังไม่เข้าชีต ของในตะกร้ายังอยู่ครบ กดลองอีกครั้งได้เลย';
    detail.innerHTML = `<div class="result-error">${escapeHtml(String(res.error || 'ไม่ทราบสาเหตุ'))}</div>`;
  }
  modal.classList.add('active');
}

function closeResultModal() {
  document.getElementById('modal-result').classList.remove('active');
}

function nowLocalString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ================================================================
 *  ORDER HISTORY (Page C)
 *  Read-only view of what actually got saved into Orders_<store_id>,
 *  so there's never a reason to open Google Sheets on the phone just to
 *  confirm a save. Cancelling an order marks it "ยกเลิก" in the sheet —
 *  the row is never deleted, and a cancelled order stops counting toward
 *  the courier commission.
 * ================================================================ */
async function openHistory() {
  if (!state.currentStore) return;
  document.getElementById('history-store-name').textContent = 'ประวัติ · ' + state.currentStore.name;
  showPage('page-history');
  loadOrders();
}

async function loadOrders() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="history-empty">กำลังโหลด...</div>';
  document.getElementById('history-stats').innerHTML = '';
  try {
    const res = await apiGet('getOrders', { store_id: state.currentStore.store_id, limit: 100 });
    if (!res.ok) throw new Error(res.error || 'load failed');
    state.orders = res.orders || [];
    renderHistory();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<div class="history-empty">โหลดประวัติไม่สำเร็จ — ตรวจสอบการเชื่อมต่อแล้วกด ⟳ อีกครั้ง</div>';
  }
}

function visibleOrders() {
  if (state.historyScope === 'mine') {
    return state.orders.filter(o => String(o.client_id) === String(state.clientId));
  }
  return state.orders;
}

function isVoided(order) {
  return String(order.status || '').trim() === 'ยกเลิก';
}

function renderHistory() {
  const listEl = document.getElementById('history-list');
  const statsEl = document.getElementById('history-stats');
  const orders = visibleOrders();

  const today = nowLocalString().slice(0, 10);
  const todayOrders = orders.filter(o => String(o.timestamp || '').slice(0, 10) === today && !isVoided(o));
  const todayTotal = todayOrders.reduce((s, o) => s + Number(o.total || 0), 0);
  statsEl.innerHTML = `
    <div class="history-stat"><span>ออเดอร์วันนี้</span><b>${todayOrders.length} รายการ</b></div>
    <div class="history-stat"><span>ยอดรวมวันนี้</span><b>${todayTotal.toLocaleString('th-TH')} บาท</b></div>
  `;

  if (!orders.length) {
    listEl.innerHTML = '<div class="history-empty">ยังไม่มีออเดอร์</div>';
    return;
  }

  let html = '';
  let lastDate = '';
  orders.forEach(o => {
    const ts = String(o.timestamp || '');
    const date = ts.slice(0, 10);
    const time = ts.slice(11, 16);
    if (date !== lastDate) {
      lastDate = date;
      html += `<div class="history-date">${escapeHtml(date === today ? 'วันนี้ · ' + date : date)}</div>`;
    }

    const voided = isVoided(o);
    const lines = (o.items || []).map(it => `
      <div class="history-item-line">
        <span>${escapeHtml(it.item_name)} x${escapeHtml(String(it.qty))}</span>
        <span>${escapeHtml(String(it.line_total !== undefined ? it.line_total : (Number(it.price || 0) * Number(it.qty || 0))))}.-</span>
      </div>`).join('') || '<div class="history-item-line"><span>ไม่มีรายละเอียดสินค้า</span></div>';

    html += `
      <div class="history-card${voided ? ' voided' : ''}" data-order-id="${escapeHtml(String(o.order_id))}">
        <div class="history-card-head">
          <span class="history-time">${escapeHtml(time)}</span>
          <span class="history-badge${voided ? ' void' : ''}">${escapeHtml(voided ? 'ยกเลิกแล้ว' : 'บันทึกแล้ว')}</span>
          <span class="history-total">${Number(o.total || 0).toLocaleString('th-TH')}.-</span>
        </div>
        <div class="history-meta">${escapeHtml(o.user_name || '-')} · ส่งโดย ${escapeHtml(o.courier || '-')}${o.customer_name ? ` · ลูกค้า ${escapeHtml(o.customer_name)}` : ''}</div>
        <div class="history-summary">${escapeHtml(o.item_summary || '')}</div>
        <div class="history-detail" hidden>
          ${lines}
          <div class="history-order-id">เลขที่ ${escapeHtml(String(o.order_id))}</div>
          ${voided ? '' : `<button class="history-void-btn" data-void="${escapeHtml(String(o.order_id))}">ยกเลิกออเดอร์นี้</button>`}
        </div>
      </div>`;
  });

  listEl.innerHTML = html;
}

async function voidOrder(orderId) {
  const ok = confirm('ยืนยันยกเลิกออเดอร์นี้?\nแถวในชีตจะไม่ถูกลบ แต่จะถูกทำเครื่องหมายว่า "ยกเลิก" และไม่ถูกนับเป็นยอดขาย/ค่าส่งอีก');
  if (!ok) return;
  showToast('กำลังยกเลิก...');
  try {
    const res = await apiPost('voidOrder', { store_id: state.currentStore.store_id, order_id: orderId });
    if (res.ok) {
      showToast('ยกเลิกออเดอร์แล้ว');
      loadOrders();
      loadCourierEarnings();
    } else {
      showToast('ยกเลิกไม่สำเร็จ: ' + res.error);
    }
  } catch (err) {
    console.error(err);
    showToast('ยกเลิกไม่สำเร็จ ตรวจสอบการเชื่อมต่อ');
  }
}

/* ---------------- Event bindings ---------------- */
function bindEvents() {
  document.getElementById('btn-confirm-name').addEventListener('click', confirmNewUser);

  // courier earnings panel - "จ่ายแล้ว/รีเซ็ต" buttons (delegated since the
  // panel's content is re-rendered each time earnings load)
  document.getElementById('courier-earnings-lines').addEventListener('click', (e) => {
    const btn = e.target.closest('.courier-reset-btn');
    if (btn) resetCourierEarnings(btn.dataset.courier);
  });

  // avatar picker inside the "new user" welcome modal
  document.getElementById('avatar-picker-new').addEventListener('click', () => {
    document.getElementById('input-avatar-new').click();
  });
  document.getElementById('input-avatar-new').addEventListener('change', (e) => {
    handleNewAvatarChosen(e.target.files[0]);
  });

  // tap the profile avatar on the store-picker page anytime to change it
  document.getElementById('profile-avatar').addEventListener('click', () => {
    document.getElementById('input-avatar-existing').click();
  });
  document.getElementById('input-avatar-existing').addEventListener('change', (e) => {
    handleExistingAvatarChosen(e.target.files[0]);
  });

  document.getElementById('btn-back').addEventListener('click', () => showPage('page-login'));

  document.getElementById('product-grid').addEventListener('click', (e) => {
    const stepBtn = e.target.closest('.stepper-btn');
    if (stepBtn) {
      const id = stepBtn.dataset.id;
      changeQty(id, stepBtn.dataset.action === 'inc' ? 1 : -1);
      return;
    }
    const box = e.target.closest('.product-box');
    if (box) {
      changeQty(box.dataset.id, 1);
    }
  });

  // ----- order history -----
  document.getElementById('btn-history').addEventListener('click', openHistory);
  document.getElementById('btn-history-back').addEventListener('click', () => showPage('page-order'));
  document.getElementById('btn-history-refresh').addEventListener('click', loadOrders);

  document.querySelector('.history-toggle').addEventListener('click', (e) => {
    const tab = e.target.closest('.history-tab');
    if (!tab) return;
    state.historyScope = tab.dataset.scope;
    document.querySelectorAll('.history-tab').forEach(t => t.classList.toggle('active', t === tab));
    renderHistory();
  });

  document.getElementById('history-list').addEventListener('click', (e) => {
    const voidBtn = e.target.closest('.history-void-btn');
    if (voidBtn) {
      voidOrder(voidBtn.dataset.void);
      return;
    }
    const card = e.target.closest('.history-card');
    if (card) {
      const detail = card.querySelector('.history-detail');
      detail.hidden = !detail.hidden;
      card.classList.toggle('open', !detail.hidden);
    }
  });

  // ----- save result modal -----
  document.getElementById('btn-result-close').addEventListener('click', closeResultModal);
  document.getElementById('btn-result-history').addEventListener('click', () => {
    closeResultModal();
    openHistory();
  });
  document.getElementById('btn-result-retry').addEventListener('click', () => {
    closeResultModal();
    if (state.lastSubmit) submitOrder(state.lastSubmit);
  });

  document.getElementById('btn-save-order').addEventListener('click', openCourierModal);
  document.getElementById('btn-cancel-courier').addEventListener('click', () => {
    document.getElementById('modal-courier').classList.remove('active');
  });

  // ----- customer section inside the checkout popup -----
  document.getElementById('customer-search').addEventListener('input', renderCustomerSuggestions);
  document.getElementById('customer-search').addEventListener('blur', () => {
    // delay so a suggestion's mousedown still registers before the list hides
    setTimeout(() => { document.getElementById('customer-suggestions').hidden = true; }, 150);
  });
  document.getElementById('btn-customer-clear').addEventListener('click', clearPickedCustomer);
  document.getElementById('btn-toggle-newcustomer').addEventListener('click', () => {
    const fields = document.getElementById('customer-new-fields');
    fields.hidden = !fields.hidden;
  });
}

document.addEventListener('DOMContentLoaded', init);

/* ---------------- PWA: register service worker (enables installability) ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW register failed', err));
  });

  // Auto-update: whenever a newer sw.js finishes installing, it takes control
  // (skipWaiting + clients.claim in sw.js) and fires "controllerchange" here.
  // Reloading at that point picks up the new app.js/index.html/style.css
  // automatically — so an installed/bookmarked icon updates itself the next
  // time it's opened, without anyone having to delete and reinstall it.
  let swRefreshedOnce = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshedOnce) return;
    swRefreshedOnce = true;
    window.location.reload();
  });
}
