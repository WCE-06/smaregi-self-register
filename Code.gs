const QUEUE_SHEET = 'commands';
const PRODUCT_SHEET = 'products';
const BRIDGE_STATUS_PROPERTY = 'BRIDGE_STATUS_JSON';
const PRODUCT_SYNC_STATUS_PROPERTY = 'PRODUCT_SYNC_STATUS_JSON';
const BRIDGE_STATUS_MAX_AGE_MS = 30000;

const ALLOWED_FINISH_ACTIONS = [
  '',
  '現金精算ボタン',
  '現金精算キャンセルボタン',
  '現金精算確定ボタン',
  'キャッシュレス決済ボタン',
  'クレジットカード決済ボタン',
  '電子マネー決済ボタン',
  '交通系電子マネー決済ボタン',
  'QUICPay決済ボタン',
  'iD決済ボタン',
  'バーコード決済ボタン'
];

const ALLOWED_SECONDARY_ACTIONS = [
  '',
  'クレジットカード決済ボタン',
  '交通系電子マネー決済ボタン',
  'QUICPay決済ボタン',
  'iD決済ボタン',
  'バーコード決済ボタン'
];

function doGet(e) {
  const params = (e && e.parameter) || {};
  if ((params.op || '') === 'pull') {
    if (!hasBridgeSecret_(params.secret || '')) return json_({ok:false, error:'AUTH'});
    return json_({ok:true, job:claimNextJob_()});
  }

  if ((params.page || '') === 'admin') {
    if (!hasAdminToken_(params.adminToken || '')) return HtmlService.createHtmlOutput('管理画面のURLが正しくありません。');
    const adminTemplate = HtmlService.createTemplateFromFile('Admin');
    adminTemplate.adminToken = params.adminToken;
    return adminTemplate.evaluate()
      .setTitle('セルフレジ 商品同期管理')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  const uiToken = params.uiToken || '';
  if (!hasUiToken_(uiToken)) return HtmlService.createHtmlOutput('アクセスURLが正しくありません。');
  const template = HtmlService.createTemplateFromFile('Index');
  template.uiToken = uiToken;
  return template.evaluate()
    .setTitle('セルフレジ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    requireBridgeSecret_(body.secret || '');

    if (body.op === 'result') {
      updateResult_(body);
      return json_({ok:true});
    }
    if (body.op === 'heartbeat') {
      saveBridgeStatus_(body.status || {});
      return json_({ok:true, serverTime:new Date().toISOString()});
    }
    return json_({ok:false, error:'INVALID_OPERATION'});
  } catch (error) {
    return json_({ok:false, error:String(error && error.message || error)});
  }
}

function setup() {
  queueSheet_();
  productSheet_();
  const id = PropertiesService.getScriptProperties().getProperty('QUEUE_SPREADSHEET_ID');
  return SpreadsheetApp.openById(id).getUrl();
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getRegisterReadiness(requiredPoints, uiToken) {
  requireUiToken_(uiToken);
  const required = Array.isArray(requiredPoints) ? requiredPoints.map(String) : [];
  const status = readBridgeStatus_();
  const requiredHealthcheck = property_('HEALTHCHECK_REQUIRED', 'false') === 'true';

  if (!status) {
    return requiredHealthcheck
      ? readiness_(false, 'BRIDGE_OFFLINE', 'レジ端末との接続を確認しています', null)
      : readiness_(true, 'LEGACY_MODE', '接続確認機能の準備中です', null);
  }

  const updatedAtMs = Date.parse(status.updatedAt || '');
  if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > BRIDGE_STATUS_MAX_AGE_MS) {
    return readiness_(false, 'BRIDGE_OFFLINE', 'Windows PCとの接続を確認してください', status);
  }
  if (status.bridge !== 'ONLINE') return readiness_(false, 'BRIDGE_OFFLINE', 'Windows PCとの接続を確認してください', status);
  if (status.pico !== 'CONNECTED') return readiness_(false, 'PICO_DISCONNECTED', 'レジ制御機器との接続を確認してください', status);
  if (status.bluetooth !== 'CONNECTED') return readiness_(false, 'BLE_DISCONNECTED', 'iPadとのBluetooth接続を確認してください', status);
  if (status.state !== 'ACTIVE') return readiness_(false, 'PICO_INACTIVE', 'レジ制御機器を起動してください', status);
  // このWebアプリは店舗の専用レジ1台で使用する。実行中の命令があっても
  // 次の命令はcommandsシートへ直列に積まれるため、busyを開始拒否には使わない。

  const missing = status.coordinates && Array.isArray(status.coordinates.missing)
    ? status.coordinates.missing.map(String)
    : [];
  const requiredMissing = required.filter(name => missing.includes(name));
  if (requiredMissing.length) {
    return readiness_(false, 'COORDINATES_MISSING', 'このお支払い方法は現在準備中です', status, requiredMissing);
  }
  if (status.coordinates && status.coordinates.ready === false && required.length) {
    return readiness_(false, 'COORDINATES_NOT_READY', 'レジ画面の設定を確認しています', status, missing);
  }
  return readiness_(true, 'READY', 'Windows PCとレジ端末の接続は正常です', status);
}

function enqueueScenario(form, uiToken) {
  requireUiToken_(uiToken);
  validateForm_(form);

  const requiredPoints = requiredPointsFor_(form);
  const readiness = getRegisterReadiness(requiredPoints, uiToken);
  if (!readiness.ready && property_('HEALTHCHECK_REQUIRED', 'false') === 'true') {
    throw new Error(readiness.code + ': ' + readiness.message);
  }

  const businessKey = String(form.businessKey || Utilities.getUuid());
  const existing = findJobByBusinessKey_(businessKey);
  if (existing) return {ok:true, id:existing.id, duplicate:true};

  const waits = waitProfile_();
  const steps = [];
  if (form.memberCode) {
    steps.push({type:'TYPE', value:form.memberCode});
    steps.push({type:'POINT', name:'会員検索ボタン'});
    steps.push({type:'WAIT', ms:waits.afterMemberSearchMs});
    if (form.useForcedNo) {
      steps.push({type:'POINT', name:'取引検索強制確認いいえボタン'});
      steps.push({type:'WAIT', ms:waits.afterForcedNoMs});
    }
  }
  form.productCodes.forEach(code => {
    steps.push({type:'TYPE', value:code});
    steps.push({type:'ENTER'});
    steps.push({type:'WAIT', ms:waits.afterProductMs});
  });
  if (form.finishAction) steps.push({type:'POINT', name:form.finishAction});
  if (form.secondaryAction) {
    steps.push({type:'WAIT', ms:2000});
    steps.push({type:'POINT', name:form.secondaryAction});
  }
  if (steps.length > 100) throw new Error('操作数が上限を超えています');

  const job = {
    id:Utilities.getUuid(),
    businessKey:businessKey,
    version:2,
    waitProfile:waits.mode,
    requiredPoints:requiredPoints,
    steps:steps
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const duplicate = findJobByBusinessKey_(businessKey);
    if (duplicate) return {ok:true, id:duplicate.id, duplicate:true};
    queueSheet_().appendRow([job.id, new Date(), 'QUEUED', JSON.stringify(job), '', '', '', businessKey]);
  } finally {
    lock.releaseLock();
  }
  return {ok:true, id:job.id, duplicate:false};
}

function enqueueCancelScenario(businessKey, uiToken) {
  requireUiToken_(uiToken);
  const key = String(businessKey || Utilities.getUuid()) + '-cancel';
  if (!/^[0-9A-Za-z_-]{8,90}$/.test(key)) throw new Error('業務キーが不正です');
  const requiredPoints = ['取引取消ボタン','取引取消確認ボタン'];
  const readiness = getRegisterReadiness(requiredPoints, uiToken);
  if (!readiness.ready) throw new Error(readiness.code + ': ' + readiness.message);
  const existing = findJobByBusinessKey_(key);
  if (existing) return {ok:true,id:existing.id,duplicate:true};
  const job = {
    id:Utilities.getUuid(),businessKey:key,version:2,waitProfile:'POINT_WAIT_V2',requiredPoints:requiredPoints,
    steps:[
      {type:'POINT',name:'取引取消ボタン'},
      {type:'WAIT',ms:2000},
      {type:'POINT',name:'取引取消確認ボタン'},
      {type:'WAIT',ms:2000}
    ]
  };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const duplicate = findJobByBusinessKey_(key);
    if (duplicate) return {ok:true,id:duplicate.id,duplicate:true};
    queueSheet_().appendRow([job.id,new Date(),'QUEUED',JSON.stringify(job),'','','',key]);
  } finally {
    lock.releaseLock();
  }
  return {ok:true,id:job.id,duplicate:false};
}

function getJobStatus(jobId, uiToken) {
  requireUiToken_(uiToken);
  const values = queueSheet_().getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === String(jobId)) {
      return {id:values[i][0], status:values[i][2], result:values[i][6]};
    }
  }
  return {id:jobId, status:'NOT_FOUND', result:''};
}

function getCustomerProducts(uiToken) {
  requireUiToken_(uiToken);
  const sheet = productSheet_();
  if (sheet.getLastRow() < 2) return {products:[], sync:readProductSyncStatus_()};
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const products = rows.map(row => ({
    productId:String(row[0] || ''),
    code:String(row[1] || ''),
    name:String(row[2] || ''),
    price:Number(row[3] || 0),
    categoryId:String(row[4] || ''),
    tag:String(row[5] || ''),
    displaySequence:Number(row[6] || 0),
    section:String(row[7] || 'shop'),
    barcode:row[8] === true,
    icon:String(row[9] || '🛍️'),
    basePrice:Number(row[10] || row[3] || 0),
    taxDivision:String(row[11] == null ? '0' : row[11]),
    taxRate:Number(row[12] == null || row[12] === '' ? 10 : row[12]),
    priceLabel:String(row[13] || '税込')
  })).filter(product => product.code && product.name);
  return {products:products, sync:readProductSyncStatus_()};
}

function verifyMemberCode(memberCode, uiToken) {
  requireUiToken_(uiToken);
  const code = String(memberCode || '').trim().toUpperCase();
  if (!/^[0-9A-Z]+$/.test(code) || code.length > 64) {
    return {found:false, code:'INVALID_MEMBER_CODE'};
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'MEMBER_EXISTS_' + Utilities.base64EncodeWebSafe(code).slice(0, 80);
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const contractId = requiredProperty_('SMAREGI_CONTRACT_ID');
  const apiBase = smaregiEnvironment_() === 'sandbox' ? 'https://api.smaregi.dev' : 'https://api.smaregi.jp';
  let token = getSmaregiCustomerAccessToken_();
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = UrlFetchApp.fetch(
      apiBase + '/' + encodeURIComponent(contractId) + '/pos/customers?customer_code=' + encodeURIComponent(code) + '&limit=20',
      {method:'get', headers:{Authorization:'Bearer ' + token}, muteHttpExceptions:true}
    );
    if (attempt === 0 && (response.getResponseCode() === 401 || response.getResponseCode() === 403)) {
      token = getSmaregiCustomerAccessToken_(true);
      continue;
    }
    break;
  }
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) throw new Error('SMAREGI_MEMBERS_HTTP_' + statusCode);
  const customers = JSON.parse(response.getContentText() || '[]');
  if (!Array.isArray(customers)) throw new Error('SMAREGI_MEMBERS_INVALID_RESPONSE');
  const matches = customers.filter(customer => String(customer.customerCode || '').trim().toUpperCase() === code);
  if (matches.length !== 1) {
    const notFound = {found:false, code:matches.length ? 'MEMBER_CODE_DUPLICATED' : 'MEMBER_NOT_FOUND'};
    cache.put(cacheKey, JSON.stringify(notFound), 60);
    return notFound;
  }
  const customer = matches[0];
  const name = String(customer.customerName || customer.customerNameKana || '').trim();
  const result = {found:true, code:'MEMBER_FOUND', memberCode:code, name:name};
  cache.put(cacheKey, JSON.stringify(result), 300);
  return result;
}

function runProductSync(adminToken) {
  requireAdminToken_(adminToken);
  return syncProducts();
}

function getProductSyncStatus(adminToken) {
  requireAdminToken_(adminToken);
  const status = readProductSyncStatus_();
  const sheet = productSheet_();
  return {
    status:status,
    storedCount:Math.max(0, sheet.getLastRow() - 1),
    triggerInstalled:property_('PRODUCT_SYNC_TRIGGER_INSTALLED', 'false') === 'true'
  };
}

function installProductSyncTrigger(adminToken) {
  requireAdminToken_(adminToken);
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'syncProducts') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncProducts').timeBased().everyMinutes(15).create();
  PropertiesService.getScriptProperties().setProperty('PRODUCT_SYNC_TRIGGER_INSTALLED', 'true');
  return getProductSyncStatus(adminToken);
}

function syncProducts() {
  const startedAt = new Date();
  saveProductSyncStatus_({state:'RUNNING', startedAt:startedAt.toISOString()});
  try {
    const source = fetchAllSmaregiProducts_();
    const normalized = [];
    let excludedCount = 0;

    source.forEach(item => {
      const product = normalizeSmaregiProduct_(item);
      if (!product) {
        excludedCount++;
        return;
      }
      normalized.push(product);
    });
    normalized.sort((a, b) => a.displaySequence - b.displaySequence || a.name.localeCompare(b.name, 'ja'));

    // API通信中はロックしない。レジ命令の登録を妨げないよう、シート更新時だけ短時間ロックする。
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = productSheet_();
      if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
      if (normalized.length) {
        sheet.getRange(2, 1, normalized.length, 14).setValues(normalized.map(product => [
          product.productId,
          product.code,
          product.name,
          product.price,
          product.categoryId,
          product.tag,
          product.displaySequence,
          product.section,
          product.barcode,
          product.icon,
          product.basePrice,
          product.taxDivision,
          product.taxRate,
          product.priceLabel
        ]));
      }
    } finally {
      lock.releaseLock();
    }
    const status = {
      state:'COMPLETED',
      startedAt:startedAt.toISOString(),
      completedAt:new Date().toISOString(),
      fetchedCount:source.length,
      storedCount:normalized.length,
      excludedCount:excludedCount,
      message:'商品情報を更新しました'
    };
    saveProductSyncStatus_(status);
    return status;
  } catch (error) {
    const status = {
      state:'ERROR',
      startedAt:startedAt.toISOString(),
      completedAt:new Date().toISOString(),
      message:String(error && error.message || error)
    };
    saveProductSyncStatus_(status);
    throw error;
  }
}

function fetchAllSmaregiProducts_() {
  const contractId = requiredProperty_('SMAREGI_CONTRACT_ID');
  const apiBase = smaregiEnvironment_() === 'sandbox' ? 'https://api.smaregi.dev' : 'https://api.smaregi.jp';
  let token = getSmaregiAccessToken_();
  const limit = 1000;
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const query = [
      'display_flag=1',
      'division=0',
      'sales_division=0',
      'limit=' + limit,
      'page=' + page
    ].join('&');
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = UrlFetchApp.fetch(apiBase + '/' + encodeURIComponent(contractId) + '/pos/products?' + query, {
        method:'get',
        headers:{Authorization:'Bearer ' + token},
        muteHttpExceptions:true
      });
      if (attempt === 0 && (response.getResponseCode() === 401 || response.getResponseCode() === 403)) {
        token = getSmaregiAccessToken_(true);
        continue;
      }
      break;
    }
    const statusCode = response.getResponseCode();
    if (statusCode !== 200) throw new Error('SMAREGI_PRODUCTS_HTTP_' + statusCode + ': ' + response.getContentText().slice(0, 300));
    const pageItems = JSON.parse(response.getContentText() || '[]');
    if (!Array.isArray(pageItems)) throw new Error('SMAREGI_PRODUCTS_INVALID_RESPONSE');
    Array.prototype.push.apply(all, pageItems);
    if (pageItems.length < limit) break;
    if (page === 100) throw new Error('SMAREGI_PRODUCTS_PAGE_LIMIT');
  }
  return all;
}

function getSmaregiAccessToken_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (forceRefresh) cache.remove('SMAREGI_APP_ACCESS_TOKEN');
  const cached = cache.get('SMAREGI_APP_ACCESS_TOKEN');
  if (cached) return cached;

  const contractId = requiredProperty_('SMAREGI_CONTRACT_ID');
  const clientId = requiredProperty_('SMAREGI_CLIENT_ID');
  const clientSecret = requiredProperty_('SMAREGI_CLIENT_SECRET');
  const idBase = smaregiEnvironment_() === 'sandbox' ? 'https://id.smaregi.dev' : 'https://id.smaregi.jp';
  const response = UrlFetchApp.fetch(idBase + '/app/' + encodeURIComponent(contractId) + '/token', {
    method:'post',
    contentType:'application/x-www-form-urlencoded',
    headers:{Authorization:'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret)},
    payload:{grant_type:'client_credentials', scope:'pos.products:read'},
    muteHttpExceptions:true
  });
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) throw new Error('SMAREGI_TOKEN_HTTP_' + statusCode + ': ' + response.getContentText().slice(0, 300));
  const data = JSON.parse(response.getContentText() || '{}');
  if (!data.access_token) throw new Error('SMAREGI_TOKEN_MISSING');
  const cacheSeconds = Math.max(60, Math.min(3300, Number(data.expires_in || 3600) - 60));
  cache.put('SMAREGI_APP_ACCESS_TOKEN', data.access_token, cacheSeconds);
  return data.access_token;
}

function getSmaregiCustomerAccessToken_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'SMAREGI_CUSTOMER_ACCESS_TOKEN';
  if (forceRefresh) cache.remove(cacheKey);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const contractId = requiredProperty_('SMAREGI_CONTRACT_ID');
  const clientId = requiredProperty_('SMAREGI_CLIENT_ID');
  const clientSecret = requiredProperty_('SMAREGI_CLIENT_SECRET');
  const idBase = smaregiEnvironment_() === 'sandbox' ? 'https://id.smaregi.dev' : 'https://id.smaregi.jp';
  const response = UrlFetchApp.fetch(idBase + '/app/' + encodeURIComponent(contractId) + '/token', {
    method:'post',
    contentType:'application/x-www-form-urlencoded',
    headers:{Authorization:'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret)},
    payload:{grant_type:'client_credentials', scope:'pos.customers:read'},
    muteHttpExceptions:true
  });
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) throw new Error('SMAREGI_MEMBER_TOKEN_HTTP_' + statusCode);
  const data = JSON.parse(response.getContentText() || '{}');
  if (!data.access_token) throw new Error('SMAREGI_MEMBER_TOKEN_MISSING');
  const cacheSeconds = Math.max(60, Math.min(3300, Number(data.expires_in || 3600) - 60));
  cache.put(cacheKey, data.access_token, cacheSeconds);
  return data.access_token;
}

function normalizeSmaregiProduct_(item) {
  const code = String(item.productCode || '').trim();
  const name = String(item.productName || '').trim();
  if (!code || !name || !/^[0-9A-Za-z]+$/.test(code) || code.length > 64) return null;
  const tags = String(item.tag || '').split(/[,\s]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
  if (tags.includes('SELFREG_HIDDEN')) return null;

  let section = 'shop';
  let icon = '🛍️';
  if (tags.includes('SELFREG_KITCHEN')) { section = 'kitchen'; icon = '🍴'; }
  if (tags.includes('SELFREG_ATELIER')) { section = 'atelier'; icon = '🎨'; }
  const noBarcode = tags.includes('SELFREG_NOBARCODE');
  const basePrice = Number(item.customerPrice || item.price || 0);
  const taxDivision = String(item.taxDivision == null ? '0' : item.taxDivision);
  const taxRate = productTaxRate_(item);
  const taxExcluded = taxDivision === '1';
  const displayPrice = taxExcluded ? roundTaxIncludedPrice_(basePrice, taxRate) : basePrice;
  return {
    productId:String(item.productId || ''),
    code:code,
    name:name,
    price:displayPrice,
    categoryId:String(item.categoryId || ''),
    tag:String(item.tag || ''),
    displaySequence:Number(item.displaySequence || 999999999),
    section:section,
    barcode:!noBarcode,
    icon:icon,
    basePrice:basePrice,
    taxDivision:taxDivision,
    taxRate:taxRate,
    priceLabel:taxDivision === '2' ? '非課税' : (taxExcluded ? '税込（税抜登録）' : '税込')
  };
}

function productTaxRate_(item) {
  const tags = String(item.tag || '').split(/[,\s]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
  const reduceTaxId = String(item.reduceTaxId || '');
  // スマレジ固定ID: 特定商品の軽減税率、または「軽減を適用」。
  // 部門の税設定を使用する商品も、商品APIのreduceTaxIdへ解決済みの値が返る。
  if (reduceTaxId === '10000001' || reduceTaxId === '10000003') return 8;
  // 状態によって税率を選択する商品は、SELFREG_TAX8で顧客画面側の税率を明示できる。
  if (tags.includes('SELFREG_TAX8')) return 8;
  // 契約独自の軽減税率IDはScript PropertyのJSONで対応する。
  // 例: SMAREGI_REDUCE_TAX_RATES_JSON={"20000001":8}
  try {
    const customRates = JSON.parse(property_('SMAREGI_REDUCE_TAX_RATES_JSON', '{}'));
    const customRate = Number(customRates[reduceTaxId]);
    if (reduceTaxId && Number.isFinite(customRate) && customRate >= 0 && customRate <= 100) return customRate;
  } catch (error) {
    // 設定値が壊れている場合は標準税率へフォールバックする。
  }
  const standardRate = Number(property_('SMAREGI_STANDARD_TAX_RATE', '10'));
  return Number.isFinite(standardRate) && standardRate >= 0 && standardRate <= 100 ? standardRate : 10;
}

function roundTaxIncludedPrice_(basePrice, taxRate) {
  const rawPrice = Number(basePrice) * (100 + Number(taxRate)) / 100;
  // スマレジの税丸め方式: 0=四捨五入、1=切り捨て、2=切り上げ。
  const rounding = property_('SMAREGI_TAX_ROUNDING', '1');
  if (rounding === '0') return Math.round(rawPrice);
  if (rounding === '2') return Math.ceil(rawPrice);
  return Math.floor(rawPrice);
}

function smaregiEnvironment_() {
  return property_('SMAREGI_ENVIRONMENT', 'production') === 'sandbox' ? 'sandbox' : 'production';
}

function saveProductSyncStatus_(status) {
  PropertiesService.getScriptProperties().setProperty(PRODUCT_SYNC_STATUS_PROPERTY, JSON.stringify(status));
}

function readProductSyncStatus_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PRODUCT_SYNC_STATUS_PROPERTY);
  if (!raw) return {state:'NOT_SYNCED', message:'まだ商品同期を実行していません'};
  try { return JSON.parse(raw); } catch (error) { return {state:'ERROR', message:'同期状態を読み取れません'}; }
}

function waitProfile_() {
  const status = readBridgeStatus_();
  const modern = !!(status && Number(status.protocolVersion) >= 2 && status.pointWaitHandled === true);
  return modern
    ? {mode:'POINT_WAIT_V2', afterMemberSearchMs:2000, afterForcedNoMs:3000, afterProductMs:2000}
    : {mode:'LEGACY_TOTAL_WAIT', afterMemberSearchMs:10500, afterForcedNoMs:11500, afterProductMs:2000};
}

function requiredPointsFor_(form) {
  const names = [];
  if (form.memberCode) names.push('会員検索ボタン');
  if (form.memberCode && form.useForcedNo) names.push('取引検索強制確認いいえボタン');
  if (form.finishAction) names.push(form.finishAction);
  if (form.secondaryAction) names.push(form.secondaryAction);
  return Array.from(new Set(names));
}

function validateForm_(form) {
  if (!form || typeof form !== 'object') throw new Error('入力内容が不正です');
  const alphaNum = /^[0-9A-Za-z]+$/;
  if (form.memberCode && (!alphaNum.test(form.memberCode) || form.memberCode.length > 64)) throw new Error('会員コードが不正です');
  if (!Array.isArray(form.productCodes) || form.productCodes.length > 30) throw new Error('商品コード数が不正です');
  form.productCodes.forEach(value => {
    if (!alphaNum.test(value) || value.length > 64) throw new Error('商品コードが不正です');
  });
  if (!ALLOWED_FINISH_ACTIONS.includes(form.finishAction || '')) throw new Error('終了操作が不正です');
  if (!ALLOWED_SECONDARY_ACTIONS.includes(form.secondaryAction || '')) throw new Error('追加操作が不正です');
  if (form.businessKey && !/^[0-9A-Za-z_-]{8,80}$/.test(form.businessKey)) throw new Error('業務キーが不正です');
}

function saveBridgeStatus_(incoming) {
  if (!incoming || typeof incoming !== 'object') throw new Error('INVALID_STATUS');
  const allowed = {
    protocolVersion:Number(incoming.protocolVersion || 1),
    pointWaitHandled:incoming.pointWaitHandled === true,
    bridge:String(incoming.bridge || ''),
    pico:String(incoming.pico || ''),
    bluetooth:String(incoming.bluetooth || ''),
    state:String(incoming.state || ''),
    coordinates:{
      ready:!!(incoming.coordinates && incoming.coordinates.ready),
      missing:incoming.coordinates && Array.isArray(incoming.coordinates.missing)
        ? incoming.coordinates.missing.map(String).slice(0, 100)
        : []
    },
    busy:incoming.busy === true,
    updatedAt:new Date().toISOString()
  };
  PropertiesService.getScriptProperties().setProperty(BRIDGE_STATUS_PROPERTY, JSON.stringify(allowed));
}

function readBridgeStatus_() {
  const raw = PropertiesService.getScriptProperties().getProperty(BRIDGE_STATUS_PROPERTY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (error) { return null; }
}

function readiness_(ready, code, message, status, missing) {
  return {
    ready:ready,
    code:code,
    message:message,
    missing:missing || [],
    protocolVersion:status ? Number(status.protocolVersion || 1) : null,
    pointWaitHandled:!!(status && status.pointWaitHandled)
  };
}

function claimNextJob_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = queueSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][2] === 'QUEUED') {
        const job = JSON.parse(values[i][3]);
        sheet.getRange(i + 1, 3).setValue('RUNNING');
        sheet.getRange(i + 1, 5).setValue(new Date());
        return job;
      }
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

function updateResult_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = queueSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i >= 1; i--) {
      if (String(values[i][0]) === String(body.jobId)) {
        if (values[i][2] !== 'RUNNING') throw new Error('INVALID_JOB_STATE');
        sheet.getRange(i + 1, 3).setValue(body.ok ? 'COMPLETED' : 'ERROR');
        sheet.getRange(i + 1, 6).setValue(new Date());
        sheet.getRange(i + 1, 7).setValue(JSON.stringify({message:body.message, details:body.details || []}));
        return;
      }
    }
    throw new Error('JOB_NOT_FOUND');
  } finally {
    lock.releaseLock();
  }
}

function findJobByBusinessKey_(businessKey) {
  if (!businessKey) return null;
  const values = queueSheet_().getDataRange().getValues();
  const start = Math.max(1, values.length - 100);
  for (let i = values.length - 1; i >= start; i--) {
    if (String(values[i][7] || '') === businessKey && values[i][2] !== 'ERROR') {
      return {id:String(values[i][0]), status:String(values[i][2])};
    }
  }
  return null;
}

function queueSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('QUEUE_SPREADSHEET_ID');
  let book;
  if (!id) {
    book = SpreadsheetApp.create('Smaregi Controller Queue');
    id = book.getId();
    props.setProperty('QUEUE_SPREADSHEET_ID', id);
  } else {
    book = SpreadsheetApp.openById(id);
  }
  let sheet = book.getSheetByName(QUEUE_SHEET);
  if (!sheet) sheet = book.insertSheet(QUEUE_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['id','createdAt','status','payload','startedAt','finishedAt','result','businessKey']);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < 8) {
    sheet.getRange(1, 8).setValue('businessKey');
  }
  return sheet;
}

function productSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('QUEUE_SPREADSHEET_ID');
  if (!id) queueSheet_();
  const book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('QUEUE_SPREADSHEET_ID'));
  let sheet = book.getSheetByName(PRODUCT_SHEET);
  if (!sheet) sheet = book.insertSheet(PRODUCT_SHEET);
  const headers = ['productId','productCode','productName','price','categoryId','tag','displaySequence','section','barcode','icon','basePrice','taxDivision','taxRate','priceLabel'];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function property_(name, fallback) {
  return PropertiesService.getScriptProperties().getProperty(name) || fallback;
}

function requiredProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('MISSING_SCRIPT_PROPERTY: ' + name);
  return value;
}

function requireBridgeSecret_(value) {
  if (!hasBridgeSecret_(value)) throw new Error('AUTH');
}

function requireUiToken_(value) {
  if (!hasUiToken_(value)) throw new Error('AUTH');
}

function requireAdminToken_(value) {
  if (!hasAdminToken_(value)) throw new Error('AUTH');
}

function hasBridgeSecret_(value) {
  return safeEqual_(String(value || ''), property_('BRIDGE_SECRET', ''));
}

function hasUiToken_(value) {
  return safeEqual_(String(value || ''), property_('UI_ACCESS_TOKEN', ''));
}

function hasAdminToken_(value) {
  return safeEqual_(String(value || ''), property_('ADMIN_ACCESS_TOKEN', ''));
}

function safeEqual_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
