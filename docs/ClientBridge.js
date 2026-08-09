/**
 * セルフレジUIとGASを分離するための接続層。
 * このファイルには秘密鍵や操作権限付きURLを記載しない。
 */
const GAS_UI_TOKEN = window.GAS_UI_TOKEN;
const GAS_API_URL = window.GAS_API_URL || '';

window.RegisterBridge = (() => {
  const TERMINAL_STATUSES = new Set(['COMPLETED', 'ERROR', 'NOT_FOUND']);

  function available() {
    return nativeAvailable() || remoteAvailable();
  }

  function nativeAvailable() {
    return !!(window.google && google.script && google.script.run);
  }

  function remoteAvailable() {
    return !!(GAS_API_URL && GAS_UI_TOKEN);
  }

  function remoteCall(action, payload) {
    if (!remoteAvailable()) return Promise.reject(new Error('REMOTE_API_NOT_CONFIGURED'));
    return new Promise((resolve, reject) => {
      const callback = '__gasUiCallback_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const timer = setTimeout(() => finish(new Error('REMOTE_API_TIMEOUT')), 20000);
      function finish(error, value) {
        clearTimeout(timer);
        delete window[callback];
        script.remove();
        error ? reject(error) : resolve(value);
      }
      window[callback] = response => {
        if (!response || response.ok !== true) {
          finish(new Error(String(response && response.error || 'REMOTE_API_ERROR')));
          return;
        }
        finish(null, response.result);
      };
      script.onerror = () => finish(new Error('REMOTE_API_NETWORK_ERROR'));
      const query = new URLSearchParams({
        api:'ui', action:String(action), uiToken:String(GAS_UI_TOKEN),
        callback:callback, payload:JSON.stringify(payload || {})
      });
      script.src = GAS_API_URL + (GAS_API_URL.includes('?') ? '&' : '?') + query.toString();
      document.head.appendChild(script);
    });
  }

  function createBusinessKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID().replace(/-/g, '_');
    }
    return 'sale_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
  }

  function readiness(requiredPoints) {
    if (!available()) {
      return Promise.resolve({
        ready:true,
        code:'LOCAL_PREVIEW',
        message:'画面確認モードです',
        missing:[]
      });
    }
    if (!nativeAvailable()) return remoteCall('readiness', {requiredPoints:requiredPoints || []});
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(normalizeError(error)))
        .getRegisterReadiness(requiredPoints || [], GAS_UI_TOKEN);
    });
  }

  function enqueue(input) {
    const form = {
      memberCode:String(input.memberCode || '').trim(),
      useForcedNo:input.useForcedNo !== false,
      productCodes:Array.isArray(input.productCodes) ? input.productCodes.map(String) : [],
      finishAction:String(input.finishAction || ''),
      secondaryAction:String(input.secondaryAction || ''),
      businessKey:String(input.businessKey || createBusinessKey())
    };
    if (!available()) {
      return Promise.resolve({ok:true, id:'LOCAL-PREVIEW', duplicate:false, preview:true});
    }
    if (!nativeAvailable()) return remoteCall('enqueue', {form});
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(normalizeError(error)))
        .enqueueScenario(form, GAS_UI_TOKEN);
    });
  }

  function cancel(businessKey) {
    if (!available()) return Promise.resolve({ok:true,id:'LOCAL-CANCEL',duplicate:false,preview:true});
    if (!nativeAvailable()) return remoteCall('cancel', {businessKey:String(businessKey || createBusinessKey())});
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(normalizeError(error)))
        .enqueueCancelScenario(String(businessKey || createBusinessKey()), GAS_UI_TOKEN);
    });
  }

  function products() {
    if (!available()) return Promise.resolve({products:[], sync:{state:'LOCAL_PREVIEW'}});
    if (!nativeAvailable()) return remoteCall('products', {});
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(normalizeError(error)))
        .getCustomerProducts(GAS_UI_TOKEN);
    });
  }

  function member(memberCode) {
    if (!available()) return Promise.resolve({found:true, code:'LOCAL_PREVIEW', memberCode:String(memberCode || '')});
    if (!nativeAvailable()) return remoteCall('member', {memberCode:String(memberCode || '')});
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(normalizeError(error)))
        .verifyMemberCode(String(memberCode || ''), GAS_UI_TOKEN);
    });
  }

  function adminLogin(password) {
    if (!available()) return Promise.reject(new Error('ADMIN_LOGIN_UNAVAILABLE'));
    if (!nativeAvailable()) return remoteCall('adminLogin', {password:String(password || '')});
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(normalizeError(error)))
        .employeeAdminLogin(String(password || ''), GAS_UI_TOKEN);
    });
  }

  function getStatus(jobId) {
    if (!available()) return Promise.resolve({id:jobId, status:'COMPLETED', result:'LOCAL_PREVIEW'});
    if (!nativeAvailable()) return remoteCall('status', {jobId:String(jobId || '')});
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(error => reject(normalizeError(error)))
        .getJobStatus(jobId, GAS_UI_TOKEN);
    });
  }

  async function watch(jobId, onUpdate, options) {
    const timeoutMs = Number(options && options.timeoutMs || 180000);
    const intervalMs = Number(options && options.intervalMs || 1500);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await getStatus(jobId);
      if (typeof onUpdate === 'function') onUpdate(status);
      if (TERMINAL_STATUSES.has(status.status)) return status;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('REGISTER_TIMEOUT');
  }

  function customerMessage(value) {
    const source = String(value && (value.code || value.message || value) || '');
    if (/BLE_DISCONNECTED|BLE=DISCONNECTED/.test(source)) return 'お会計の準備をしています。少しお待ちください。';
    if (/PICO_DISCONNECTED|serial port not found/.test(source)) return 'お会計の準備をしています。少しお待ちください。';
    if (/COORDINATES|POINT_NOT_REGISTERED/.test(source)) return 'このお支払い方法は現在準備中です。';
    if (/REGISTER_BUSY/.test(source)) return 'ただいま別のお会計を処理しています。少しお待ちください。';
    if (/PRODUCTS_NOT_SYNCED|商品同期/.test(source)) return '商品情報を準備しています。管理画面から商品同期を実行してください。';
    if (/BRIDGE_OFFLINE|OFFLINE/.test(source)) return 'お会計の準備をしています。少しお待ちください。';
    if (/REGISTER_TIMEOUT|NO_RESPONSE/.test(source)) return '処理を確認できませんでした。最初からもう一度お試しください。';
    return '処理を完了できませんでした。最初からもう一度お試しください。';
  }

  function normalizeError(error) {
    const normalized = new Error(String(error && error.message || error || 'UNKNOWN_ERROR'));
    normalized.original = error;
    return normalized;
  }

  return {available, createBusinessKey, readiness, products, member, adminLogin, enqueue, cancel, getStatus, watch, customerMessage};
})();
