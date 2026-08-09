const QUEUE_SHEET = 'commands';
const PRODUCT_SHEET = 'products';
const MENU_CONFIG_SHEET = 'menu_config';
const INVENTORY_RECEIPT_SHEET = 'inventory_receipts';
const BRIDGE_STATUS_PROPERTY = 'BRIDGE_STATUS_JSON';
const PRODUCT_SYNC_STATUS_PROPERTY = 'PRODUCT_SYNC_STATUS_JSON';
const BRIDGE_STATUS_MAX_AGE_MS = 60000;

const ALLOWED_FINISH_ACTIONS = [
  '',
  'お会計ボタン',
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
  if ((params.api || '') === 'ui') {
    return handleUiApi_(params);
  }
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

  if ((params.page || '') === 'menu-admin') {
    if (!hasAdminToken_(params.adminToken || '')) return HtmlService.createHtmlOutput('管理画面のURLが正しくありません。');
    const menuTemplate = HtmlService.createTemplateFromFile('MenuAdmin');
    menuTemplate.adminToken = params.adminToken;
    return menuTemplate.evaluate()
      .setTitle('Aozora kitchen メニュー編集')
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

function handleUiApi_(params) {
  const callback = String(params.callback || '');
  try {
    const payload = params.payload ? JSON.parse(params.payload) : {};
    const uiToken = String(params.uiToken || '');
    let result;
    switch (String(params.action || '')) {
      case 'readiness':
        result = getRegisterReadiness(payload.requiredPoints || [], uiToken);
        break;
      case 'enqueue':
        result = enqueueScenario(payload.form || {}, uiToken);
        break;
      case 'cancel':
        result = enqueueCancelScenario(String(payload.businessKey || ''), uiToken, String(payload.context || 'transaction'));
        break;
      case 'products':
        result = getCustomerProducts(uiToken);
        break;
      case 'member':
        result = verifyMemberCode(String(payload.memberCode || ''), uiToken);
        break;
      case 'status':
        result = getJobStatus(String(payload.jobId || ''), uiToken);
        break;
      case 'adminLogin':
        result = employeeAdminLogin(String(payload.password || ''), uiToken);
        break;
      default:
        throw new Error('INVALID_UI_ACTION');
    }
    return jsonp_({ok:true, result:result}, callback);
  } catch (error) {
    return jsonp_({ok:false, error:String(error && error.message || error)}, callback);
  }
}

function jsonp_(value, callback) {
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return json_({ok:false, error:'INVALID_CALLBACK'});
  }
  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(value) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
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
    return readiness_(false, 'COORDINATES_NOT_READY', 'ただいまお会計の準備をしています', status, missing);
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
    steps.push({type:'WAIT', ms:waits.betweenPaymentActionsMs});
    steps.push({type:'POINT', name:form.secondaryAction});
  }
  if (steps.length > 100) throw new Error('操作数が上限を超えています');

  const job = {
    id:Utilities.getUuid(),
    businessKey:businessKey,
    dependsOnJobId:String(form.dependsOnJobId || ''),
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

function enqueueCancelScenario(businessKey, uiToken, context) {
  requireUiToken_(uiToken);
  const cancelContext = String(context || 'transaction');
  if (!['transaction','cash','cashless','electronic'].includes(cancelContext)) throw new Error('取消位置が不正です');
  const key = String(businessKey || Utilities.getUuid()) + '-cancel-' + cancelContext;
  if (!/^[0-9A-Za-z_-]{8,120}$/.test(key)) throw new Error('業務キーが不正です');
  const preActions = cancelContext === 'cash'
    ? ['現金精算キャンセルボタン']
    : cancelContext === 'cashless'
      ? ['キャッシュレス決済キャンセルボタン']
      : cancelContext === 'electronic'
        ? ['キャッシュレス決済キャンセルボタン','キャッシュレス決済キャンセルボタン']
        : [];
  const requiredPoints = [...new Set([...preActions,'取引取消ボタン','取引取消確認ボタン'])];
  const readiness = getRegisterReadiness(requiredPoints, uiToken);
  if (!readiness.ready) throw new Error(readiness.code + ': ' + readiness.message);
  const existing = findJobByBusinessKey_(key);
  if (existing) return {ok:true,id:existing.id,duplicate:true};
  const steps = [];
  preActions.forEach((name, index) => {
    steps.push({type:'POINT',name:name});
    const isLastPaymentCancel = index === preActions.length - 1;
    steps.push({
      type:'WAIT',
      ms:isLastPaymentCancel
        ? waitValue_('WAIT_AFTER_PAYMENT_CANCEL_MS',5000)
        : waitValue_('WAIT_BETWEEN_PAYMENT_ACTIONS_MS',800)
    });
  });
  steps.push(
    {type:'POINT',name:'取引取消ボタン'},
    {type:'WAIT',ms:waitValue_('WAIT_AFTER_CANCEL_MS',800)},
    {type:'POINT',name:'取引取消確認ボタン'},
    {type:'WAIT',ms:waitValue_('WAIT_AFTER_CANCEL_CONFIRM_MS',800)}
  );
  const job = {
    id:Utilities.getUuid(),businessKey:key,version:2,waitProfile:'POINT_WAIT_V2',requiredPoints:requiredPoints,
    steps:steps
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

function getCustomerProducts(uiToken, includeUnavailable) {
  requireUiToken_(uiToken);
  if (!includeUnavailable) {
    const cached = readCustomerProductsCache_();
    if (cached) return cached;
  }
  const sheet = productSheet_();
  if (sheet.getLastRow() < 2) return {products:[], sync:readProductSyncStatus_()};
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const menuConfigs = readMenuConfigMap_();
  const products = rows.map(row => {
    const code = String(row[1] || '');
    const productName = String(row[2] || '');
    const categoryId = String(row[4] || '');
    const config = menuConfigs[code] || null;
    const kitchenAsset = aozoraKitchenAsset_(productName);
    const isAozoraMenuName = Boolean(kitchenAsset) || isAozoraMenuName_(productName);
    const isAozoraCategory = categoryId === '32' || categoryId === '33';
    const isMocktail = /モクテル|ノンアル/.test(productName);
    const cocktailRecipe = isMocktail ? null : aozoraCocktailRecipe_(productName);
    let optionGroups = [];
    try { optionGroups = config && config.optionGroupsJson ? JSON.parse(config.optionGroupsJson) : []; } catch (error) {}
    const hasManualConfig = Boolean(config && (
      config.imageUrl || config.description || config.optionGroupsJson || config.menuCategory ||
      (Array.isArray(config.flags) && config.flags.length) || config.available === false
    ));
    const fallbackSection = isAozoraMenuName || cocktailRecipe || isAozoraCategory || isAozoraProductCode_(code)
      ? 'kitchen'
      : String(row[7] || 'shop');
    const managedSection = hasManualConfig ? String(config.section || fallbackSection) : fallbackSection;
    const managedCategory = hasManualConfig
      ? String(config.menuCategory || '')
      : String(isMocktail ? 'soft-mocktail' : (cocktailRecipe ? 'alcohol-cocktail' : ''));
    return {
    productId:String(row[0] || ''),
    code:code,
    name:productName,
    price:Number(row[3] || 0),
    categoryId:categoryId,
    tag:String(row[5] || ''),
    displaySequence:Number(config && config.displayOrder !== '' && config.displayOrder != null ? config.displayOrder : (row[6] || 0)),
    section:managedSection,
    barcode:row[8] === true,
    icon:String(row[9] || '🛍️'),
    basePrice:Number(row[10] || row[3] || 0),
    taxDivision:String(row[11] == null ? '0' : row[11]),
    taxRate:Number(row[12] == null || row[12] === '' ? 10 : row[12]),
    taxRounding:String(property_('SMAREGI_TAX_ROUNDING', '1')),
    priceLabel:String(row[13] || '税込'),
    imageUrl:String(config && config.imageUrl || kitchenAsset || row[14] || ''),
    description:String(config && config.description || row[15] || ''),
    menuCategory:managedCategory,
    flags:config && Array.isArray(config.flags) ? config.flags : [],
    cocktailBase:cocktailRecipe ? cocktailRecipe.base : '',
    cocktailMixer:cocktailRecipe ? cocktailRecipe.mixer : '',
    optionGroups:optionGroups,
    available:(!config || config.available !== false) && managedSection !== 'hidden',
    managed:Boolean(config)
  };}).filter(product => product.code && product.name && (includeUnavailable || product.available));
  products.sort((a,b) => a.displaySequence - b.displaySequence || a.name.localeCompare(b.name, 'ja'));
  const result = {products:products, sync:readProductSyncStatus_()};
  if (!includeUnavailable) writeCustomerProductsCache_(result);
  return result;
}

function warmCustomerProductsCache() {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get('CUSTOMER_PRODUCTS_CHUNKS') || 0);
  cache.remove('CUSTOMER_PRODUCTS_CHUNKS');
  for (let i = 0; i < count; i++) cache.remove('CUSTOMER_PRODUCTS_' + i);
  return getCustomerProducts(requiredProperty_('UI_ACCESS_TOKEN'), false).products.length;
}

function readCustomerProductsCache_() {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get('CUSTOMER_PRODUCTS_CHUNKS') || 0);
  if (!count) return null;
  let json = '';
  for (let i = 0; i < count; i++) {
    const part = cache.get('CUSTOMER_PRODUCTS_' + i);
    if (part == null) return null;
    json += part;
  }
  try { return JSON.parse(json); } catch (error) { return null; }
}

function writeCustomerProductsCache_(value) {
  const cache = CacheService.getScriptCache();
  const json = JSON.stringify(value);
  const chunkSize = 80000;
  const count = Math.ceil(json.length / chunkSize);
  for (let i = 0; i < count; i++) {
    cache.put('CUSTOMER_PRODUCTS_' + i, json.slice(i * chunkSize, (i + 1) * chunkSize), 900);
  }
  cache.put('CUSTOMER_PRODUCTS_CHUNKS', String(count), 900);
}

function aozoraCocktailRecipe_(productName) {
  const name = String(productName || '').replace(/[\s　]+/g, '');
  let base = '';
  if (/角ハイ|\(角\)|角ロック|ウイスキー角/.test(name)) base = 'ウイスキー（角）';
  else if (/バーボン/.test(name)) base = 'バーボン';
  else if (/^梅酒/.test(name)) base = '梅酒';
  else if (/麦焼酎|\(麦\)/.test(name)) base = '麦焼酎';
  else if (/芋焼酎|\(芋\)/.test(name)) base = '芋焼酎';
  else if (/^泡盛/.test(name)) base = '泡盛';
  else if (/^テキーラ|メキシカン|ブレイブ/.test(name)) base = 'テキーラ';
  else if (/^カシス/.test(name)) base = 'カシス';
  else if (/^ストロベリー|大人のいちご/.test(name)) base = 'ストロベリー';
  else if (/^ピーチ|レゲエパンチ|ファジーネーブル/.test(name)) base = 'ピーチ';
  else if (/^レモン|大人のレモネード/.test(name)) base = 'レモン';
  else if (/^カルーア|スミス・アンド・ウエッソン/.test(name)) base = 'カルーア';
  else if (/^ビアコーク/.test(name)) base = 'ビール';
  if (!base) return null;

  let mixer = '';
  if (/ロック|ショット|ハーフロック/.test(name)) mixer = 'ロック／ストレート';
  else if (/ラムネ/.test(name)) mixer = 'ラムネ';
  else if (/カルピス/.test(name)) mixer = 'カルピス';
  else if (/ミルク|いちごミルク|ウエッソン/.test(name)) mixer = 'ミルク';
  else if (/オレンジ|サンライズ|ファジーネーブル/.test(name)) mixer = 'オレンジ';
  else if (/ウーロン|レゲエパンチ/.test(name)) mixer = 'ウーロン茶';
  else if (/緑茶|グリーンティー/.test(name)) mixer = '緑茶';
  else if (/コーク|コーラ|ブレイブ/.test(name)) mixer = 'コーラ';
  else if (/水割り/.test(name)) mixer = '水';
  else if (/ソーダ|ハイボール|サワー|レモネード/.test(name)) mixer = 'ソーダ';
  if (!mixer) return null;
  return {base:base, mixer:mixer};
}

function aozoraKitchenAsset_(productName) {
  const base = 'https://self-service-resources.smaregi.app/production/skgp650g5/layout_menu_items/product_images/';
  const normalized = String(productName || '').replace(/[\s　]+/g, '').toLowerCase();
  const assets = {
    'にんにくからあげ':'product_image_1777537176_1689466785.jpg',
    '相盛りからあげ':'product_image_1777537191_82431848.jpg',
    '和風からあげ':'product_image_1777537125_530876683.jpg',
    'ふりふりポテトしお':'product_image_1777537291_807228877.jpg',
    'ふりふりポテトコンソメ':'product_image_1777537363_1295913909.jpg',
    'ふりふりポテトバターしょうゆ':'product_image_1777537372_1468858727.jpg',
    'チーズドッグケチャップ＆マスタード':'product_image_1777537807_830015385.jpg',
    'チーズドッグハニー＆マスタード':'product_image_1777537798_112444847.jpg',
    '磯辺揚げ':'product_image_1777781666_479182187.jpg',
    '揚げたこ焼':'product_image_1777783990_1970817271.jpg',
    'フライドチキン':'product_image_1784229926_737350989.jpg',
    '贅沢ポテトボロネーゼ風':'product_image_1777540000_1989080340.jpg',
    '贅沢ポテトカルボナーラ風':'product_image_1777539992_61798126.jpg',
    '和風からあげ丼':'product_image_1777537949_38733724.jpg',
    'にんにくからあげ丼':'product_image_1777537963_985687319.jpg',
    '相盛りからあげ丼':'product_image_1777537978_1559150914.jpg',
    '角煮丼':'product_image_1777539010_1442682524.jpg',
    'カツ丼':'product_image_1777538995_1144950376.jpg',
    '卵かけご飯':'product_image_1783832607_1801925729.jpg',
    '濃厚魚介つけ麺':'product_image_1777539105_860198633.jpg',
    'きつねうどん':'product_image_1783832528_8625086.jpg',
    'かけうどん':'product_image_1783832857_763744818.jpg',
    'ほうとう':'product_image_1777790021_1024900588.jpg',
    'ボロネーゼパスタ':'product_image_1784300708_1605368157.jpg',
    'カルボナーラパスタ':'product_image_1783832848_491620697.jpg',
    '温泉卵':'product_image_1777790570_1785587093.jpg'
  };
  return assets[normalized] ? base + assets[normalized] : '';
}

function isAozoraMenuName_(productName) {
  const name = String(productName || '').replace(/[\s　]+/g, '');
  return /全部(?:載せ|のせ)うどん|きつねうどん|かけうどん|わかめうどん|ほうとう/.test(name);
}

function isAozoraProductCode_(productCode) {
  const code = String(productCode || '').trim().toLowerCase();
  return /(?:^|_)(?:tukemen|tsukemen|udon|houtou|hoto|don|pasta|karaage|potato|cheese_?dog|hot_?dog|coffee|latte|cocoa|juice|mocktail|cocktail)(?:_|$)/.test(code)
    || /^(?:kakuni_don|kitsune_udon|kake_udon)$/.test(code);
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

function getManagementSpreadsheetUrl(adminToken) {
  requireAdminToken_(adminToken);
  productSheet_();
  menuConfigSheet_();
  inventoryReceiptSheet_();
  const id = requiredProperty_('QUEUE_SPREADSHEET_ID');
  return {url:SpreadsheetApp.openById(id).getUrl(), sheetName:MENU_CONFIG_SHEET};
}

function getMenuManagementData(adminToken) {
  requireAdminToken_(adminToken);
  const result = getCustomerProducts(property_('UI_ACCESS_TOKEN', ''), true);
  return {products:result.products};
}

function employeeAdminLogin(password, uiToken) {
  requireUiToken_(uiToken);
  const cache = CacheService.getScriptCache();
  const attempts = Number(cache.get('EMPLOYEE_ADMIN_FAILED_ATTEMPTS') || 0);
  if (attempts >= 10) throw new Error('ADMIN_LOGIN_LOCKED');
  const expected = property_('EMPLOYEE_ADMIN_PASSWORD', property_('ADMIN_ACCESS_TOKEN', ''));
  if (!safeEqual_(String(password || ''), expected)) {
    cache.put('EMPLOYEE_ADMIN_FAILED_ATTEMPTS', String(attempts + 1), 600);
    throw new Error('ADMIN_LOGIN_FAILED');
  }
  cache.remove('EMPLOYEE_ADMIN_FAILED_ATTEMPTS');
  return {
    ok:true,
    url:ScriptApp.getService().getUrl() + '?page=admin&adminToken=' + encodeURIComponent(requiredProperty_('ADMIN_ACCESS_TOKEN'))
  };
}

function getInventoryManagementData(adminToken) {
  requireAdminToken_(adminToken);
  const products = getMenuManagementData(adminToken).products.map(product => ({
    code:product.code,
    name:product.name,
    section:product.section
  }));
  const sheet = inventoryReceiptSheet_();
  const lots = sheet.getLastRow() < 2 ? [] : sheet.getRange(2,1,sheet.getLastRow()-1,8).getValues().map(row => ({
    id:String(row[0] || ''),
    productCode:String(row[1] || ''),
    productName:String(row[2] || ''),
    quantity:Number(row[3] || 0),
    remainingQuantity:Number(row[4] || 0),
    expiryDate:row[5] instanceof Date ? Utilities.formatDate(row[5], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(row[5] || ''),
    receivedAt:row[6] instanceof Date ? row[6].toISOString() : String(row[6] || ''),
    note:String(row[7] || '')
  })).sort((a,b) => String(a.expiryDate || '9999-12-31').localeCompare(String(b.expiryDate || '9999-12-31')));
  return {products:products, lots:lots};
}

function addInventoryReceipt(input, adminToken) {
  requireAdminToken_(adminToken);
  input = input || {};
  const code = String(input.productCode || '').trim();
  const quantity = Math.floor(Number(input.quantity || 0));
  const expiryDate = String(input.expiryDate || '').trim();
  if (!/^[0-9A-Za-z_-]+$/.test(code) || quantity < 1 || quantity > 100000) throw new Error('INVALID_INVENTORY_INPUT');
  if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) throw new Error('INVALID_EXPIRY_DATE');
  const productRows = productSheet_().getDataRange().getValues();
  const productRow = productRows.slice(1).find(row => String(row[1] || '') === code);
  if (!productRow) throw new Error('PRODUCT_NOT_FOUND');
  const id = Utilities.getUuid();
  inventoryReceiptSheet_().appendRow([id,code,String(productRow[2] || ''),quantity,quantity,expiryDate ? new Date(expiryDate + 'T00:00:00+09:00') : '',new Date(),String(input.note || '').slice(0,200)]);
  return {ok:true,id:id};
}

function saveMenuProductConfig(input, adminToken) {
  requireAdminToken_(adminToken);
  if (!input || typeof input !== 'object') throw new Error('INVALID_MENU_CONFIG');
  const productCode = String(input.productCode || '').trim();
  if (!/^[0-9A-Za-z_-]+$/.test(productCode) || productCode.length > 64) throw new Error('INVALID_PRODUCT_CODE');
  const imageUrl = String(input.imageUrl || '').trim();
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new Error('IMAGE_URL_MUST_BE_HTTPS');
  const description = String(input.description || '').trim().slice(0, 500);
  const optionGroups = validateOptionGroups_(input.optionGroups || []);
  const available = input.available !== false;
  const section = ['shop','kitchen','atelier','hidden'].includes(String(input.section || '')) ? String(input.section) : 'shop';
  const categoryValues = ['','food-tsukemen','food-udon','food-pasta','food-don','food-side','soft-cafe','soft-simple','soft-mocktail','alcohol-main','alcohol-cocktail','dessert'];
  const menuCategory = categoryValues.includes(String(input.menuCategory || '')) ? String(input.menuCategory || '') : '';
  const displayOrder = String(input.displayOrder == null ? '' : input.displayOrder).trim() === '' ? '' : Math.max(0, Math.min(999999, Math.floor(Number(input.displayOrder))));
  if (displayOrder !== '' && !Number.isFinite(displayOrder)) throw new Error('INVALID_DISPLAY_ORDER');
  const allowedFlags = ['recommended','new','limited','popular','spicy'];
  const flags = Array.isArray(input.flags) ? input.flags.map(String).filter((value,index,array) => allowedFlags.includes(value) && array.indexOf(value) === index) : [];
  const sheet = menuConfigSheet_();
  const values = sheet.getDataRange().getValues();
  let row = 0;
  for (let i = 1; i < values.length; i++) if (String(values[i][0]) === productCode) { row = i + 1; break; }
  const productRows = productSheet_().getDataRange().getValues();
  const productRow = productRows.slice(1).find(product => String(product[1] || '') === productCode);
  const productName = productRow ? String(productRow[2] || '') : '';
  const record = [productCode,imageUrl,description,JSON.stringify(optionGroups),available,new Date(),section,displayOrder,menuCategory,flags.join(','),productName];
  if (row) sheet.getRange(row,1,1,record.length).setValues([record]);
  else sheet.appendRow(record);
  return {ok:true, productCode:productCode};
}

function saveMenuLayout(entries, adminToken) {
  requireAdminToken_(adminToken);
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('INVALID_MENU_LAYOUT');
  const allowedCategories = ['food-tsukemen','food-udon','food-pasta','food-don','food-side','soft-cafe','soft-simple','soft-mocktail','alcohol-main','alcohol-cocktail','dessert'];
  const sheet = menuConfigSheet_();
  const values = sheet.getDataRange().getValues();
  const rowMap = {};
  for (let i = 1; i < values.length; i++) rowMap[String(values[i][0] || '')] = i + 1;
  entries.forEach((entry,index) => {
    const code = String(entry && entry.productCode || '').trim();
    const category = String(entry && entry.menuCategory || '');
    if (!/^[0-9A-Za-z_-]+$/.test(code) || !allowedCategories.includes(category)) throw new Error('INVALID_MENU_LAYOUT_ENTRY_' + index);
    const order = Math.max(0, Math.min(999999, Math.floor(Number(entry.displayOrder || 0))));
    const existingRow = rowMap[code];
    if (existingRow) {
      sheet.getRange(existingRow,7,1,3).setValues([['kitchen',order,category]]);
    } else {
      const productRows = productSheet_().getDataRange().getValues();
      const productRow = productRows.slice(1).find(product => String(product[1] || '') === code);
      sheet.appendRow([code,'','',JSON.stringify([]),true,new Date(),'kitchen',order,category,'',productRow ? String(productRow[2] || '') : '']);
      rowMap[code] = sheet.getLastRow();
    }
  });
  return {ok:true, updatedCount:entries.length};
}

function validateOptionGroups_(groups) {
  if (!Array.isArray(groups) || groups.length > 10) throw new Error('INVALID_OPTION_GROUPS');
  return groups.map((group, groupIndex) => {
    const name = String(group && group.name || '').trim();
    if (!name) throw new Error('OPTION_GROUP_NAME_REQUIRED_' + groupIndex);
    const type = group.type === 'multiple' ? 'multiple' : 'single';
    const choices = Array.isArray(group.choices) ? group.choices : [];
    if (!choices.length || choices.length > 20) throw new Error('INVALID_OPTION_CHOICES_' + groupIndex);
    return {
      id:String(group.id || 'group_' + groupIndex).replace(/[^0-9A-Za-z_-]/g,'_').slice(0,40),
      name:name.slice(0,60),
      type:type,
      required:group.required !== false,
      choices:choices.map((choice, choiceIndex) => ({
        id:String(choice && choice.id || 'choice_' + choiceIndex).replace(/[^0-9A-Za-z_-]/g,'_').slice(0,40),
        name:String(choice && choice.name || '').trim().slice(0,60),
        priceDelta:Math.max(0,Math.min(99999,Number(choice && choice.priceDelta || 0))),
        productCode:String(choice && choice.productCode || '').trim().slice(0,64)
      }))
    };
  });
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
    const imageMap = fetchAllSmaregiProductImages_();
    const normalized = [];
    let excludedCount = 0;

    source.forEach(item => {
      const product = normalizeSmaregiProduct_(item);
      if (!product) {
        excludedCount++;
        return;
      }
      product.imageUrl = imageMap[product.productId] || '';
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
        sheet.getRange(2, 1, normalized.length, 16).setValues(normalized.map(product => [
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
          product.priceLabel,
          product.imageUrl,
          product.description
        ]));
      }
      ensureMenuConfigRows_(normalized);
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

function fetchAllSmaregiProductImages_() {
  const contractId = requiredProperty_('SMAREGI_CONTRACT_ID');
  const apiBase = smaregiEnvironment_() === 'sandbox' ? 'https://api.smaregi.dev' : 'https://api.smaregi.jp';
  let token = getSmaregiAccessToken_();
  const images = {};
  const limit = 1000;
  for (let page = 1; page <= 100; page++) {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = UrlFetchApp.fetch(apiBase + '/' + encodeURIComponent(contractId) + '/pos/products/images?limit=' + limit + '&page=' + page, {
        method:'get',headers:{Authorization:'Bearer ' + token},muteHttpExceptions:true
      });
      if (attempt === 0 && (response.getResponseCode() === 401 || response.getResponseCode() === 403)) {
        token = getSmaregiAccessToken_(true); continue;
      }
      break;
    }
    if (response.getResponseCode() !== 200) throw new Error('SMAREGI_PRODUCT_IMAGES_HTTP_' + response.getResponseCode());
    const items = JSON.parse(response.getContentText() || '[]');
    if (!Array.isArray(items)) throw new Error('SMAREGI_PRODUCT_IMAGES_INVALID_RESPONSE');
    items.forEach(item => { if (item.productId && item.url && item.url !== 'failed') images[String(item.productId)] = String(item.url); });
    if (items.length < limit) break;
  }
  return images;
}

function fetchAllSmaregiProducts_() {
  const contractId = requiredProperty_('SMAREGI_CONTRACT_ID');
  const apiBase = smaregiEnvironment_() === 'sandbox' ? 'https://api.smaregi.dev' : 'https://api.smaregi.jp';
  let token = getSmaregiAccessToken_();
  const limit = 1000;
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const query = [
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
  // モバイルオーダー専用商品はPOS端末で非表示（displayFlag=0）の場合がある。
  // 非表示商品を無条件には公開せず、Aozora kitchen対象と判定できるものだけ同期する。
  return all.filter(item => {
    const name = String(item.productName || '');
    const tags = String(item.tag || '').split(/[,\s]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
    const normalPosProduct = String(item.displayFlag == null ? '1' : item.displayFlag) === '1' &&
      String(item.division == null ? '0' : item.division) === '0' &&
      String(item.salesDivision == null ? '0' : item.salesDivision) === '0';
    const knownKitchenProduct = tags.includes('SELFREG_KITCHEN') || Boolean(aozoraKitchenAsset_(name)) ||
      isAozoraMenuName_(name) || Boolean(aozoraCocktailRecipe_(name));
    return normalPosProduct || knownKitchenProduct;
  });
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
  if (!code || !name || !/^[0-9A-Za-z_-]+$/.test(code) || code.length > 64) return null;
  const tags = String(item.tag || '').split(/[,\s]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
  if (tags.includes('SELFREG_HIDDEN')) return null;

  let section = 'shop';
  let icon = '🛍️';
  const categoryId = String(item.categoryId || '');
  if (categoryId === '32' || categoryId === '33') { section = 'kitchen'; icon = '🍴'; }
  if (isAozoraMenuName_(name) || aozoraKitchenAsset_(name) || isAozoraProductCode_(code)) { section = 'kitchen'; icon = '🍴'; }
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
    categoryId:categoryId,
    tag:String(item.tag || ''),
    displaySequence:Number(item.displaySequence || 999999999),
    section:section,
    barcode:!noBarcode,
    icon:icon,
    basePrice:basePrice,
    taxDivision:taxDivision,
    taxRate:taxRate,
    priceLabel:taxDivision === '2' ? '非課税' : (taxExcluded ? '税込（税抜登録）' : '税込'),
    description:String(item.description || item.catchCopy || '').trim().slice(0,500)
  };
}

function inferManagedMenuCategory_(product) {
  const name = String(product && product.name || '');
  const code = String(product && product.code || '').toLowerCase();
  if (/モクテル|ノンアル/.test(name)) return 'soft-mocktail';
  if (aozoraCocktailRecipe_(name) || /カクテル|レゲエパンチ|モスコミュール|カシス|ファジーネーブル/.test(name)) return 'alcohol-cocktail';
  if (/コーヒーゼリー|かき氷|アイスクリーム|ソフトクリーム|ジェラート|ケーキ|パフェ|プリン|ゼリー|クレープ|スイーツ/.test(name)) return 'dessert';
  if (/コーヒー|ココア|いちごミルク|ミルクティー|カフェラテ|ラテ|紅茶/.test(name)) return 'soft-cafe';
  if (/ビール|焼酎|泡盛|梅酒|日本酒|ワイン|ウイスキー|ハイボール|サワー|酎ハイ|テキーラ/.test(name)) return 'alcohol-main';
  if (/ジュース|ソフトドリンク|ソーダ|コーラ|ラムネ|カルピス|ウーロン茶|緑茶|オレンジ|アップル/.test(name)) return 'soft-simple';
  if (/つけ麺/.test(name) || /t?su?kemen/.test(code)) return 'food-tsukemen';
  if (/うどん|ほうとう/.test(name) || /udon|houtou|hoto/.test(code)) return 'food-udon';
  if (/パスタ|スパゲッティ/.test(name) || /pasta/.test(code)) return 'food-pasta';
  if (/丼|ご飯|ライス/.test(name) || /(?:^|_)don(?:_|$)/.test(code)) return 'food-don';
  return 'food-side';
}

function ensureMenuConfigRows_(products) {
  const sheet = menuConfigSheet_();
  const values = sheet.getDataRange().getValues();
  const rowMap = {};
  for (let i = 1; i < values.length; i++) {
    const code = String(values[i][0] || '');
    if (code) rowMap[code] = i + 1;
  }
  const productNameMap = {};
  const productMap = {};
  products.forEach(product => {
    productNameMap[product.code] = product.name;
    productMap[product.code] = product;
  });
  if (values.length > 1) {
    const names = values.slice(1).map(row => [productNameMap[String(row[0] || '')] || String(row[10] || '')]);
    sheet.getRange(2, 11, names.length, 1).setValues(names);

    // 既存行の空欄と、旧版がshopへ仮分類したAozora商品だけを補正する。
    // hiddenや手動で設定済みのカテゴリーは上書きしない。
    const classifications = values.slice(1).map(row => {
      const product = productMap[String(row[0] || '')];
      let section = String(row[6] || '');
      let displayOrder = row[7];
      let menuCategory = String(row[8] || '');
      if (product) {
        if (!section || (section === 'shop' && product.section === 'kitchen' && !menuCategory)) {
          section = ['shop','kitchen','atelier'].includes(product.section) ? product.section : 'hidden';
        }
        if (section === 'kitchen' && !menuCategory) menuCategory = inferManagedMenuCategory_(product);
        if (displayOrder === '') displayOrder = product.displaySequence;
      }
      return [section, displayOrder, menuCategory];
    });
    sheet.getRange(2, 7, classifications.length, 3).setValues(classifications);
  }
  const additions = [];
  products.forEach(product => {
    const existingRow = rowMap[product.code];
    if (existingRow) return;
    const section = ['shop','kitchen','atelier'].includes(product.section) ? product.section : 'hidden';
    const menuCategory = section === 'kitchen' ? inferManagedMenuCategory_(product) : '';
    additions.push([product.code,'','',JSON.stringify([]),true,new Date(),section,product.displaySequence,menuCategory,'',product.name]);
  });
  if (additions.length) sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, 11).setValues(additions);
  return {added:additions.length,total:products.length};
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
    ? {
        mode:'POINT_WAIT_V2',
        afterMemberSearchMs:waitValue_('WAIT_AFTER_MEMBER_SEARCH_MS',1300),
        afterForcedNoMs:waitValue_('WAIT_AFTER_FORCED_NO_MS',1000),
        afterProductMs:waitValue_('WAIT_AFTER_PRODUCT_MS',50),
        betweenPaymentActionsMs:waitValue_('WAIT_BETWEEN_PAYMENT_ACTIONS_MS',400)
      }
    : {
        mode:'LEGACY_TOTAL_WAIT',
        afterMemberSearchMs:10500,
        afterForcedNoMs:11500,
        afterProductMs:50,
        betweenPaymentActionsMs:2000
      };
}

function waitValue_(propertyName, fallback) {
  const value = Number(property_(propertyName, String(fallback)));
  return Number.isFinite(value) ? Math.max(300, Math.min(30000, Math.round(value))) : fallback;
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
  const productCodePattern = /^[0-9A-Za-z_-]+$/;
  if (form.memberCode && (!alphaNum.test(form.memberCode) || form.memberCode.length > 64)) throw new Error('会員コードが不正です');
  if (!Array.isArray(form.productCodes) || form.productCodes.length > 30) throw new Error('商品コード数が不正です');
  form.productCodes.forEach(value => {
    if (!productCodePattern.test(value) || value.length > 64) throw new Error('商品コードが不正です');
  });
  if (!ALLOWED_FINISH_ACTIONS.includes(form.finishAction || '')) throw new Error('終了操作が不正です');
  if (!ALLOWED_SECONDARY_ACTIONS.includes(form.secondaryAction || '')) throw new Error('追加操作が不正です');
  if (form.dependsOnJobId && !/^[0-9a-f-]{36}$/i.test(String(form.dependsOnJobId))) throw new Error('依存ジョブIDが不正です');
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
    const statusById = {};
    for (let i = 1; i < values.length; i++) statusById[String(values[i][0])] = String(values[i][2]);
    for (let i = 1; i < values.length; i++) {
      if (values[i][2] === 'QUEUED') {
        const job = JSON.parse(values[i][3]);
        if (job.dependsOnJobId) {
          const dependencyStatus = statusById[String(job.dependsOnJobId)] || 'NOT_FOUND';
          if (dependencyStatus === 'ERROR' || dependencyStatus === 'NOT_FOUND') {
            sheet.getRange(i + 1, 3).setValue('ERROR');
            sheet.getRange(i + 1, 6).setValue(new Date());
            sheet.getRange(i + 1, 7).setValue(JSON.stringify({message:'DEPENDENCY_FAILED'}));
            continue;
          }
          if (dependencyStatus !== 'COMPLETED') continue;
        }
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
  const headers = ['productId','productCode','productName','price','categoryId','tag','displaySequence','section','barcode','icon','basePrice','taxDivision','taxRate','priceLabel','smaregiImageUrl','description'];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function menuConfigSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('QUEUE_SPREADSHEET_ID');
  if (!id) queueSheet_();
  const book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('QUEUE_SPREADSHEET_ID'));
  let sheet = book.getSheetByName(MENU_CONFIG_SHEET);
  if (!sheet) sheet = book.insertSheet(MENU_CONFIG_SHEET);
  const headers = ['productCode','imageUrl','description','optionGroupsJson','available','updatedAt','section','displayOrder','menuCategory','flags','productName'];
  if (sheet.getLastRow() === 0) { sheet.appendRow(headers); sheet.setFrozenRows(1); }
  else sheet.getRange(1,1,1,headers.length).setValues([headers]);
  return sheet;
}

function inventoryReceiptSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('QUEUE_SPREADSHEET_ID');
  if (!id) queueSheet_();
  const book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('QUEUE_SPREADSHEET_ID'));
  let sheet = book.getSheetByName(INVENTORY_RECEIPT_SHEET);
  if (!sheet) sheet = book.insertSheet(INVENTORY_RECEIPT_SHEET);
  const headers = ['id','productCode','productName','quantity','remainingQuantity','expiryDate','receivedAt','note'];
  if (sheet.getLastRow() === 0) { sheet.appendRow(headers); sheet.setFrozenRows(1); }
  else sheet.getRange(1,1,1,headers.length).setValues([headers]);
  return sheet;
}

function readMenuConfigMap_() {
  const sheet = menuConfigSheet_();
  if (sheet.getLastRow() < 2) return {};
  const values = sheet.getRange(2,1,sheet.getLastRow()-1,10).getValues();
  const map = {};
  values.forEach(row => {
    const code = String(row[0] || '');
    if (code) map[code] = {imageUrl:String(row[1] || ''),description:String(row[2] || ''),optionGroupsJson:String(row[3] || ''),available:row[4] !== false,section:String(row[6] || ''),displayOrder:row[7] === '' ? '' : Number(row[7]),menuCategory:String(row[8] || ''),flags:String(row[9] || '').split(',').filter(Boolean)};
  });
  return map;
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
