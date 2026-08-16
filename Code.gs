/** ===================================================================
 *  POS Multi-Store — Apps Script backend
 *  Bind this script to the "POS_MultiStore_Database" spreadsheet
 *  (a brand-new sheet, independent from the old POS_Water_Database).
 *
 *  SETUP (one time):
 *  1. Open the spreadsheet -> Extensions > Apps Script.
 *  2. Delete any starter code, paste this whole file in.
 *  3. In the toolbar function dropdown, select "setup" and click Run.
 *     (First run asks for permission - approve it.) This creates all
 *     tabs (Stores, Users, Inventory, Couriers) with headers and seed
 *     data, plus one separate Orders tab PER STORE (e.g. Orders_shop_a,
 *     Orders_shop_b) so each store's orders are kept apart.
 *  4. Deploy > New deployment > type "Web app".
 *     - Execute as: Me
 *     - Who has access: Anyone
 *  5. Copy the Web app URL and paste it into GAS_URL in app.js.
 * =================================================================== */

const SS_ID = '1S2AXBIOSbLNGOUU3kD23H6j-ZP0ttsou8kDkSOkuFcA'; // POS_MultiStore_Database

const SHEET_STORES = 'Stores';
const SHEET_USERS = 'Users';
const SHEET_INVENTORY = 'Inventory';
const SHEET_COURIERS = 'Couriers';
const ORDERS_PREFIX = 'Orders_'; // each store gets its own tab: Orders_<store_id>
const ORDERS_HEADERS = [
  'order_id', 'timestamp', 'store_id', 'client_id', 'user_name',
  'items_json', 'item_summary', 'total', 'courier', 'status',
];

function getSS_() {
  return SpreadsheetApp.openById(SS_ID);
}

/** ================== ONE-TIME SETUP ================== */
function setup() {
  const ss = getSS_();

  // remove default "Sheet1" once real tabs exist
  const defaultSheet = ss.getSheetByName('Sheet1');

  const storeRows = [
    ['shop_a', 'ผู้ชายขายน้ำ', '💧', '#8B7FD6', true],
    ['shop_b', 'นาแบะโอนลี่', '🍘', '#8B7FD6', true],
  ];

  ensureSheet_(ss, SHEET_STORES, ['store_id', 'name', 'logo_emoji', 'color', 'active'], storeRows);

  ensureSheet_(ss, SHEET_USERS, ['client_id', 'name', 'permission', 'created_at', 'last_seen'], []);

  ensureSheet_(ss, SHEET_INVENTORY, ['store_id', 'item_id', 'item_name', 'price', 'sort_order', 'active'], [
    ['shop_a', 'a1', 'Ammarit 600ml x3', 110, 1, true],
    ['shop_a', 'a2', 'Ammarit 1500ml x3', 110, 2, true],
    ['shop_a', 'a3', 'Ammarit 600ml', 40, 3, true],
    ['shop_a', 'a4', 'Ammarit 1500ml', 40, 4, true],
    ['shop_a', 'a5', 'Crystal 600ml', 55, 5, true],
    ['shop_a', 'a6', 'Crystal 1500ml', 55, 6, true],
    ['shop_a', 'a7', 'Singha 600ml', 55, 7, true],
    ['shop_a', 'a8', 'Singha 1500ml', 55, 8, true],
    ['shop_a', 'a9', 'Ammarit 300ml', 40, 9, true],
    ['shop_b', 'b1', 'นาแบะเล็ก', 59, 1, true],
    ['shop_b', 'b2', 'นาแบะใหญ่', 79, 2, true],
    ['shop_b', 'b3', 'ข้าว', 10, 3, true],
  ]);

  ensureSheet_(ss, SHEET_COURIERS, ['courier_id', 'name', 'active'], [
    ['c1', 'ไนซ์', true],
    ['c2', 'เอฟ', true],
    ['c3', 'เทพ', true],
  ]);

  // one Orders tab per store, kept fully separate from each other
  storeRows.forEach(row => {
    const storeId = row[0];
    ensureSheet_(ss, ORDERS_PREFIX + storeId, ORDERS_HEADERS, []);
  });

  // legacy single "Orders" tab from an earlier version of this script -
  // safe to remove only if it's still empty (no real data in it)
  const legacyOrders = ss.getSheetByName('Orders');
  if (legacyOrders && legacyOrders.getLastRow() <= 1) ss.deleteSheet(legacyOrders);

  if (defaultSheet) ss.deleteSheet(defaultSheet);

  SpreadsheetApp.flush();
}

/** Returns (creating if needed) the Orders tab that belongs to a given store_id. */
function getOrdersSheet_(ss, storeId) {
  return ensureSheet_(ss, ORDERS_PREFIX + storeId, ORDERS_HEADERS, []);
}

function ensureSheet_(ss, name, headers, seedRows) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    if (seedRows.length) sh.getRange(2, 1, seedRows.length, headers.length).setValues(seedRows);
  }
  return sh;
}

/** ================== HELPERS ================== */
function sheetToObjects_(sh) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = row[i]));
      return obj;
    });
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function nowIso_() {
  return new Date().toISOString();
}

/** ================== GET (read-only queries) ================== */
function doGet(e) {
  const action = e.parameter.action;
  const ss = getSS_();

  try {
    if (action === 'getStores') {
      const stores = sheetToObjects_(ss.getSheetByName(SHEET_STORES)).filter(s => s.active);
      return jsonOut_({ ok: true, stores });
    }

    if (action === 'getInventory') {
      const storeId = e.parameter.store_id;
      const items = sheetToObjects_(ss.getSheetByName(SHEET_INVENTORY))
        .filter(i => i.active && (!storeId || i.store_id === storeId))
        .sort((a, b) => a.sort_order - b.sort_order);
      return jsonOut_({ ok: true, items });
    }

    if (action === 'getCouriers') {
      const couriers = sheetToObjects_(ss.getSheetByName(SHEET_COURIERS)).filter(c => c.active);
      return jsonOut_({ ok: true, couriers });
    }

    if (action === 'getUser') {
      const clientId = e.parameter.client_id;
      const users = sheetToObjects_(ss.getSheetByName(SHEET_USERS));
      const user = users.find(u => u.client_id === clientId);
      return jsonOut_({ ok: true, user: user || null });
    }

    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/** ================== POST (mutations) ================== */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;
    const ss = getSS_();

    if (action === 'registerUser') {
      const sh = ss.getSheetByName(SHEET_USERS);
      const users = sheetToObjects_(sh);
      let user = users.find(u => u.client_id === body.client_id);
      if (!user) {
        sh.appendRow([body.client_id, body.name || 'ผู้ใช้งาน', body.permission || 'Staff', nowIso_(), nowIso_()]);
        user = { client_id: body.client_id, name: body.name || 'ผู้ใช้งาน', permission: body.permission || 'Staff' };
      } else {
        // touch last_seen
        const rowIdx = users.findIndex(u => u.client_id === body.client_id) + 2;
        sh.getRange(rowIdx, 5).setValue(nowIso_());
      }
      return jsonOut_({ ok: true, user });
    }

    if (action === 'submitOrder') {
      const sh = getOrdersSheet_(ss, body.store_id); // each store writes to its own Orders_<store_id> tab
      const orderId = 'ORD-' + new Date().getTime();
      const items = body.items || []; // [{item_id, item_name, qty, price}]
      const total = items.reduce((s, it) => s + Number(it.qty) * Number(it.price), 0);
      const summary = items.map(it => `${it.item_name} x${it.qty}`).join(', ');

      sh.appendRow([
        orderId,
        nowIso_(),
        body.store_id,
        body.client_id,
        body.user_name || '',
        JSON.stringify(items),
        summary,
        total,
        body.courier || '',
        'บันทึกแล้ว',
      ]);

      return jsonOut_({ ok: true, order_id: orderId, total });
    }

    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}
