/**
 * GitHub Pagesの従業員管理画面とGASを接続する。
 * 長期トークンやAPI秘密鍵は保持せず、ログイン時にGASが発行した
 * 30分間の一時セッションだけを使用する。
 */
const ADMIN_GAS_API_URL = 'https://script.google.com/macros/s/AKfycbx-NlcSg-7MoAKRdySnfs05LY2Ttd3RVYEjWjcDx0MfLTE49EYazxUrV8e2CD-dAB8P/exec';
const ADMIN_SESSION = new URLSearchParams(location.search).get('session') || '';
window.ADMIN_SESSION = ADMIN_SESSION;

window.AdminBridge = (() => {
  function call(action, payload) {
    if (!/^[0-9a-f]{64}$/i.test(ADMIN_SESSION)) {
      return Promise.reject(new Error('管理画面のログイン有効期限が切れました。セルフレジのロゴを5回押して、もう一度ログインしてください。'));
    }
    return new Promise((resolve, reject) => {
      const callback = '__adminCallback_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const timer = setTimeout(() => finish(new Error('管理サーバーから応答がありません。')), 70000);
      function finish(error, value) {
        clearTimeout(timer);
        delete window[callback];
        script.remove();
        error ? reject(error) : resolve(value);
      }
      window[callback] = response => {
        if (!response || response.ok !== true) {
          const code = String(response && response.error || 'ADMIN_API_ERROR');
          finish(new Error(code === 'ADMIN_SESSION_EXPIRED'
            ? 'ログイン有効期限が切れました。セルフレジからもう一度ログインしてください。'
            : code));
          return;
        }
        finish(null, response.result);
      };
      script.onerror = () => finish(new Error('管理サーバーへ接続できません。'));
      const query = new URLSearchParams({
        api:'admin',
        action:String(action || ''),
        session:ADMIN_SESSION,
        callback:callback,
        payload:JSON.stringify(payload || {})
      });
      script.src = ADMIN_GAS_API_URL + '?' + query.toString();
      document.head.appendChild(script);
    });
  }
  return {call};
})();
