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
 *
 *  UPDATING AN EXISTING SHEET (bundle pricing added later):
 *  If your Inventory tab already existed before the bundle_group/bundle_price
 *  columns were added, run `migrateBundlePricing` once (function dropdown ->
 *  migrateBundlePricing -> Run) to add the columns and tag the Ammarit single
 *  items automatically, instead of re-running `setup`.
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

  // logo_url: relative/absolute path to a real logo image (e.g. "images/stores/shop_a.png").
  // Leave blank to keep showing the colored circle + logo_emoji as before.
  const storeRows = [
    ['shop_a', 'ผู้ชายขายน้ำ', '💧', '#8B7FD6', true, ''],
    ['shop_b', 'นาแบะโอนลี่', '🍘', '#8B7FD6', true, ''],
  ];

  ensureSheet_(ss, SHEET_STORES, ['store_id', 'name', 'logo_emoji', 'color', 'active', 'logo_url'], storeRows);

  // avatar_url is filled in automatically when a user uploads a profile photo
  // from the "new user" screen (saved to Google Drive, see doPost/registerUser).
  ensureSheet_(ss, SHEET_USERS, ['client_id', 'name', 'permission', 'created_at', 'last_seen', 'avatar_url'], []);

  // bundle_group / bundle_price: items that share the same bundle_group pool their
  // quantities together — every complete group of 3 (across sizes) is charged at
  // bundle_price, the leftover (0-2 pcs) at the item's own regular price. Leave both
  // blank for items that don't have a bundle promo.
  // image_url: relative/absolute path to a product photo (e.g. "images/products/ammarit600.png").
  // Leave blank to keep showing the plain colored box as before.
  ensureSheet_(ss, SHEET_INVENTORY, [
    'store_id', 'item_id', 'item_name', 'price', 'sort_order', 'active', 'bundle_group', 'bundle_price', 'image_url',
  ], [
    ['shop_a', 'a1', 'Ammarit 600ml x3', 110, 1, true, '', '', ''],
    ['shop_a', 'a2', 'Ammarit 1500ml x3', 110, 2, true, '', '', ''],
    ['shop_a', 'a3', 'Ammarit 600ml', 40, 3, true, 'ammarit_single', 110, ''],
    ['shop_a', 'a4', 'Ammarit 1500ml', 40, 4, true, 'ammarit_single', 110, ''],
    ['shop_a', 'a5', 'Crystal 600ml', 55, 5, true, '', '', ''],
    ['shop_a', 'a6', 'Crystal 1500ml', 55, 6, true, '', '', ''],
    ['shop_a', 'a7', 'Singha 600ml', 55, 7, true, '', '', ''],
    ['shop_a', 'a8', 'Singha 1500ml', 55, 8, true, '', '', ''],
    ['shop_a', 'a9', 'Ammarit 300ml', 40, 9, true, 'ammarit_single', 110, ''],
    ['shop_b', 'b1', 'นาแบะเล็ก', 59, 1, true, '', '', ''],
    ['shop_b', 'b2', 'นาแบะใหญ่', 79, 2, true, '', '', ''],
    ['shop_b', 'b3', 'ข้าว', 10, 3, true, '', '', ''],
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

/** ================== ONE-TIME MIGRATION (only needed if Inventory already
 *  existed before bundle pricing was added) ================== */
function migrateBundlePricing() {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_INVENTORY);
  const values = sh.getDataRange().getValues();
  const headers = values[0];

  let bundleGroupCol = headers.indexOf('bundle_group');
  let bundlePriceCol = headers.indexOf('bundle_price');

  if (bundleGroupCol === -1) {
    sh.getRange(1, headers.length + 1).setValue('bundle_group');
    bundleGroupCol = headers.length;
    headers.push('bundle_group');
  }
  if (bundlePriceCol === -1) {
    sh.getRange(1, headers.length + 1).setValue('bundle_price');
    bundlePriceCol = headers.length;
    headers.push('bundle_price');
  }

  const itemIdCol = headers.indexOf('item_id');
  const ammaritSingles = ['a3', 'a4', 'a9']; // Ammarit 600ml / 1500ml / 300ml (single pieces, 40.- each)

  for (let r = 1; r < values.length; r++) {
    if (ammaritSingles.includes(values[r][itemIdCol])) {
      sh.getRange(r + 1, bundleGroupCol + 1).setValue('ammarit_single');
      sh.getRange(r + 1, bundlePriceCol + 1).setValue(110);
    }
  }

  SpreadsheetApp.flush();
}

/** ================== ONE-TIME MIGRATION (only needed if Stores/Users/Inventory
 *  already existed before the image columns were added) ================== */
function migrateImageColumns() {
  const ss = getSS_();
  addColumnIfMissing_(ss.getSheetByName(SHEET_STORES), 'logo_url');
  addColumnIfMissing_(ss.getSheetByName(SHEET_USERS), 'avatar_url');
  addColumnIfMissing_(ss.getSheetByName(SHEET_INVENTORY), 'image_url');
  SpreadsheetApp.flush();
}

function addColumnIfMissing_(sh, headerName) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (headers.indexOf(headerName) === -1) {
    sh.getRange(1, headers.length + 1).setValue(headerName);
  }
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

/** ================== AVATAR STORAGE ==================
 *  Three different Google Drive hotlink formats were all tried and all turned
 *  out unreliable when embedded as an <img> from an outside website (and
 *  returning a raw Blob from doGet isn't supported by Apps Script Web Apps —
 *  it errors with "script completed but the return value isn't a supported
 *  result type"). The reliable fix: skip external hosting entirely and store
 *  the photo as a data: URI directly in the Users sheet. The browser renders
 *  a data: URI instantly with zero extra network requests, so there's nothing
 *  that can fail to load. The photo is already resized/compressed client-side
 *  (app.js) before it gets here, so the resulting string comfortably fits in
 *  a single Sheets cell (well under the ~50,000 character cell limit). */
function buildAvatarDataUri_(base64Data, mimeType) {
  return 'data:' + (mimeType || 'image/jpeg') + ';base64,' + base64Data;
}

/** ================== ONE-TIME MIGRATION (only needed if avatars were saved
 *  using an older Drive-hotlink URL format from an earlier version of this
 *  script — re-downloads the photo from Drive and re-saves it as a data: URI
 *  in the sheet, so nobody has to re-upload their photo). */
function migrateAvatarUrls() {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_USERS);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const avatarCol = headers.indexOf('avatar_url');
  if (avatarCol === -1) return;

  for (let r = 1; r < values.length; r++) {
    const url = String(values[r][avatarCol] || '');
    if (url.startsWith('data:')) continue; // already migrated

    const match = url.match(/thumbnail\?id=([^&]+)/)
      || url.match(/googleusercontent\.com\/d\/([^/?&]+)/)
      || url.match(/[?&]id=([^&]+)/);
    if (!match) continue;

    try {
      const blob = DriveApp.getFileById(match[1]).getBlob();
      const dataUri = buildAvatarDataUri_(Utilities.base64Encode(blob.getBytes()), blob.getContentType());
      sh.getRange(r + 1, avatarCol + 1).setValue(dataUri);
    } catch (err) {
      // file may no longer exist / not accessible - leave the cell as-is
    }
  }
  SpreadsheetApp.flush();
}

/** ================== BUNDLE PRICING ==================
 *  Items that share the same bundle_group (e.g. Ammarit 600ml / 1500ml / 300ml,
 *  all sold single at 40.-) pool their quantities together: every complete group
 *  of 3 pieces (any mix of sizes) is charged bundle_price (110.-), the remaining
 *  0-2 pieces are charged at each item's own regular price. */
function calcBundleTotal_(qty, singlePrice, bundlePrice) {
  if (!bundlePrice) return qty * singlePrice;
  const bundles = Math.floor(qty / 3);
  const rem = qty % 3;
  return bundles * bundlePrice + rem * singlePrice;
}

/** Computes a line_total for every item in the order, pooling qty across items
 *  that share the same bundle_group before applying bundle pricing, then splits
 *  the group's total back across each item's line proportionally (remainder on
 *  the last line so the lines always sum exactly to the group/order total).
 *  invById: { item_id: { bundle_group, bundle_price, ... } } from the Inventory sheet. */
function calcLineTotals_(items, invById) {
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
    const groupTotal = calcBundleTotal_(g.qty, g.singlePrice, g.bundlePrice);
    let allocated = 0;
    g.indices.forEach((idx, i) => {
      const qty = Number(items[idx].qty || 0);
      let lt;
      if (i === g.indices.length - 1) {
        lt = Number((groupTotal - allocated).toFixed(2)); // remainder absorbs rounding drift
      } else {
        lt = Number(((groupTotal * qty) / g.qty).toFixed(2));
        allocated += lt;
      }
      lineTotals[idx] = lt;
    });
  });

  return lineTotals;
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

      let avatarUrl = user ? user.avatar_url : '';
      if (body.avatar_base64) {
        avatarUrl = buildAvatarDataUri_(body.avatar_base64, body.avatar_mime);
      }

      if (!user) {
        sh.appendRow([
          body.client_id,
          body.name || 'ผู้ใช้งาน',
          body.permission || 'Staff',
          nowIso_(),
          nowIso_(),
          avatarUrl || '',
        ]);
        user = {
          client_id: body.client_id,
          name: body.name || 'ผู้ใช้งาน',
          permission: body.permission || 'Staff',
          avatar_url: avatarUrl || '',
        };
      } else {
        // touch last_seen (+ update avatar if a new one was uploaded)
        const rowIdx = users.findIndex(u => u.client_id === body.client_id) + 2;
        sh.getRange(rowIdx, 5).setValue(nowIso_());
        if (body.avatar_base64) {
          sh.getRange(rowIdx, 6).setValue(avatarUrl);
          user.avatar_url = avatarUrl;
        }
      }
      return jsonOut_({ ok: true, user });
    }

    if (action === 'submitOrder') {
      const sh = getOrdersSheet_(ss, body.store_id); // each store writes to its own Orders_<store_id> tab
      const orderId = 'ORD-' + new Date().getTime();
      const items = body.items || []; // [{item_id, item_name, qty, price}]

      // total is always recomputed server-side from the Inventory sheet's bundle
      // rules — never trusts the client's total, so pricing stays correct even if
      // the frontend is out of date.
      const invRows = sheetToObjects_(ss.getSheetByName(SHEET_INVENTORY));
      const invById = {};
      invRows.forEach(r => (invById[String(r.item_id)] = r));

      const lineTotals = calcLineTotals_(items, invById);
      const total = lineTotals.reduce((s, v) => s + v, 0);
      const summary = items.map((it, i) => `${it.item_name} x${it.qty} (${lineTotals[i]}.-)`).join(', ');
      const itemsWithTotals = items.map((it, i) => Object.assign({}, it, { line_total: lineTotals[i] }));

      sh.appendRow([
        orderId,
        nowIso_(),
        body.store_id,
        body.client_id,
        body.user_name || '',
        JSON.stringify(itemsWithTotals),
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
