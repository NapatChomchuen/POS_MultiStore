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
  couriers: [],
  cart: {},          // item_id -> { item_name, price, qty }
  pendingCourier: null,
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
  bindEvents();
}

function renderProfile() {
  document.getElementById('profile-name').textContent = state.user.name;
  document.getElementById('profile-permission').textContent = state.user.permission;
}

function openNewUserModal() {
  document.getElementById('modal-newuser').classList.add('active');
}

async function confirmNewUser() {
  const name = document.getElementById('input-username').value.trim();
  if (!name) return;
  const { user } = await apiPost('registerUser', { client_id: state.clientId, name, permission: 'Staff' });
  state.user = user;
  renderProfile();
  document.getElementById('modal-newuser').classList.remove('active');
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
    tile.innerHTML = `
      <div class="store-logo" style="background:${store.color || '#8B7FD6'}">${store.logo_emoji || ''}</div>
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
    tile.innerHTML = `
      <div class="product-box" data-id="${item.item_id}">
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

function renderSummary() {
  const linesEl = document.getElementById('summary-lines');
  const items = Object.values(state.cart);

  if (items.length === 0) {
    linesEl.innerHTML = '<div class="summary-empty">ยังไม่ได้เลือกสินค้า</div>';
  } else {
    linesEl.innerHTML = items.map(it => `
      <div class="summary-line">
        <span class="summary-line-name">${it.item_name} x${it.qty}</span>
        <span class="summary-line-amt">${it.price * it.qty}.-</span>
      </div>
    `).join('');
  }

  const total = items.reduce((s, it) => s + it.price * it.qty, 0);
  document.getElementById('summary-total').textContent = total;
}

/* ---------------- Save order -> pick courier -> submit ---------------- */
function openCourierModal() {
  const items = Object.values(state.cart);
  if (items.length === 0) {
    showToast('กรุณาเลือกสินค้าก่อน');
    return;
  }
  renderCourierOptions();
  document.getElementById('modal-courier').classList.add('active');
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
      state.pendingCourier = c.name;
      wrap.querySelectorAll('.courier-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      submitOrder();
    });
    wrap.appendChild(btn);
  });
}

async function submitOrder() {
  document.getElementById('modal-courier').classList.remove('active');
  showToast('กำลังบันทึกออเดอร์...');

  const items = Object.values(state.cart);
  try {
    const res = await apiPost('submitOrder', {
      store_id: state.currentStore.store_id,
      client_id: state.clientId,
      user_name: state.user ? state.user.name : '',
      items,
      courier: state.pendingCourier,
    });
    if (res.ok) {
      showToast(`บันทึกออเดอร์สำเร็จ (รวม ${res.total} บาท)`);
      state.cart = {};
      renderProductGrid();
      renderSummary();
    } else {
      showToast('บันทึกไม่สำเร็จ: ' + res.error);
    }
  } catch (err) {
    showToast('บันทึกไม่สำเร็จ ตรวจสอบการเชื่อมต่อ');
    console.error(err);
  }
}

/* ---------------- Event bindings ---------------- */
function bindEvents() {
  document.getElementById('btn-confirm-name').addEventListener('click', confirmNewUser);

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

  document.getElementById('btn-save-order').addEventListener('click', openCourierModal);
  document.getElementById('btn-cancel-courier').addEventListener('click', () => {
    document.getElementById('modal-courier').classList.remove('active');
  });
}

document.addEventListener('DOMContentLoaded', init);

/* ---------------- PWA: register service worker (enables installability) ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW register failed', err));
  });
}
