/* Browser platform for the unchanged, captured Mini Program business modules. */
(function (global) {
  'use strict';
  const STORAGE_PREFIX = 'eatwhat.web.v1:';
  const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  const MAX_PIXELS = 16000000;

  function response(options, successful, value) {
    if (successful) options.success?.(value);
    else options.fail?.(value);
    options.complete?.(value);
  }
  function problem(api, message) { return { errMsg: `${api}:fail ${message}` }; }
  function asyncResponse(options, successful, value) {
    queueMicrotask(() => response(options, successful, value));
  }
  function apiPath(value) {
    const url = new URL(value);
    if (url.origin !== 'https://api.eatwhat.pro' || url.username || url.password || url.hash ||
      !url.pathname.startsWith('/v1/') || /[\\\u0000-\u001f]/.test(value) || /%2f|%5c|%2e/i.test(url.pathname)) {
      throw new Error('仅允许吃什么的公开 API。');
    }
    return `/api${url.pathname}${url.search}`;
  }
  function browserCapabilities(value) {
    if (value?.authCapabilities) {
      value.authCapabilities.wechatMiniProgramEnabled = false;
      value.authCapabilities.wechatEnabled = false;
      value.authCapabilities.qqEnabled = false;
    }
    return value;
  }
  // The browser reports WGS84. Match wx.getLocation's explicitly requested CRS;
  // never label unconverted GPS coordinates as GCJ02.
  function toGcj02(latitude, longitude) {
    if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) {
      return { latitude, longitude };
    }
    const x = longitude - 105, y = latitude - 35, pi = Math.PI;
    let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    dLat += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
    dLat += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
    dLat += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
    let dLng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    dLng += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
    dLng += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
    dLng += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
    const radians = latitude / 180 * pi, sin = Math.sin(radians);
    const magic = 1 - 0.00669342162296594323 * sin * sin, sqrt = Math.sqrt(magic);
    dLat = dLat * 180 / ((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrt) * pi);
    dLng = dLng * 180 / (6378245 / sqrt * Math.cos(radians) * pi);
    return { latitude: latitude + dLat, longitude: longitude + dLng };
  }

  global.installPlatform = function installPlatform(runtime) {
    const document = global.document, navigator = global.navigator;
    const files = new Map(), activeRequests = new Set(), overlays = new Set(), activePickers = new Set();
    const theme = global.matchMedia('(prefers-color-scheme: dark)');
    const themeListeners = new Set();
    let locationPermission, imageEpoch = 0, toastTimer, toast;
    const storage = () => global.localStorage;
    const locationState = async () => {
      try { return (await navigator.permissions.query({ name: 'geolocation' })).state; }
      catch (_) { return locationPermission || 'prompt'; }
    };
    function finishRoute(options, mode) {
      try {
        const leavingImages = runtime.currentPages().at(-1)?.route === 'pages/takeout/index';
        Promise.resolve(runtime.navigate(options.url, mode)).then(() => {
          if (leavingImages && (mode === 'reLaunch' || !runtime.currentPages().some(page => page.route === 'pages/takeout/index'))) clearImages();
          response(options, true, { errMsg: `${mode}:ok` });
        }, () => response(options, false, problem(mode, '页面暂时无法打开。')));
      } catch (_) { asyncResponse(options, false, problem(mode, '页面暂时无法打开。')); }
    }
    function make(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function installStyles() {
      if (document.getElementById('eatwhat-platform-styles')) return;
      const style = make('style');
      style.id = 'eatwhat-platform-styles';
      style.textContent = `
        .ew-dialog{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:24px 16px;background:#10182066;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-sizing:border-box;color:#182b3d}
        .ew-dialog-panel{width:min(100%,420px);max-height:calc(100dvh - 48px);overflow:auto;box-sizing:border-box;padding:24px;border:1px solid #ffffffb3;border-radius:28px;background:#f6f9fcf5;box-shadow:0 25px 90px #142b4044;font:16px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}
        .ew-dialog-title{margin:0 0 12px;font-size:20px;font-weight:700}.ew-dialog-copy{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;color:#526478}
        .ew-dialog-actions{display:flex;gap:10px;margin-top:22px}.ew-dialog button{display:block;min-height:46px;box-sizing:border-box;flex:1;border:0;border-radius:16px;padding:10px 14px;background:#e7edf4;color:#24425d;font:600 15px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;cursor:pointer;touch-action:manipulation}
        .ew-dialog button.ew-confirm{background:#286edf;color:white}.ew-dialog button:focus-visible{outline:3px solid #226ce7;outline-offset:3px}.ew-dialog button:active{transform:scale(.98)}
        .ew-dialog-input{width:100%;box-sizing:border-box;margin-top:14px;padding:12px;border:1px solid #bac8d7;border-radius:12px;font:16px/1.5 sans-serif}.ew-action-list{display:grid;gap:8px;margin-top:12px}.ew-action-list button{width:100%;text-align:left}
        .ew-toast{position:fixed;left:50%;bottom:calc(100px + env(safe-area-inset-bottom));z-index:2147483640;max-width:min(360px,calc(100vw - 40px));box-sizing:border-box;transform:translateX(-50%);border-radius:16px;padding:12px 18px;background:#172b3ce8;color:#fff;font:14px/1.6 sans-serif;box-shadow:0 8px 40px #0002;text-align:center;pointer-events:none}
        .ew-preview-image{display:block;width:100%;max-height:65dvh;object-fit:contain;border-radius:12px;background:#e9edf1}.ew-image-nav{display:flex;align-items:center;gap:10px;margin-top:14px;text-align:center}.ew-image-nav span{flex:1;font-size:13px}
        .ew-crop-stage{position:relative;user-select:none;-webkit-user-select:none;touch-action:none;background:#121a24;border-radius:12px;overflow:hidden;line-height:0;margin-top:12px}.ew-crop-stage img{display:block;width:100%;max-height:55dvh;object-fit:contain;pointer-events:none}.ew-crop-selection{position:absolute;border:2px solid #fff;box-shadow:0 0 0 9999px #0007;box-sizing:border-box;pointer-events:none}.ew-crop-note{font-size:13px;color:#526478;margin:10px 0 0}
        @media(prefers-color-scheme:dark){.ew-dialog{color:#e8f0fa}.ew-dialog-panel{background:#172331f5;border-color:#45607899}.ew-dialog-copy,.ew-crop-note{color:#b2c2d3}.ew-dialog button{background:#2d4258;color:#e8f0fa}.ew-dialog-input{background:#22364a;color:white;border-color:#546c83}}
      `;
      document.head.append(style);
    }
    function dialog(title, cancelled) {
      installStyles();
      const root = make('div', undefined, 'ew-dialog'), panel = make('div', undefined, 'ew-dialog-panel');
      const heading = make('h2', title, 'ew-dialog-title');
      heading.id = `ew-dialog-${Math.random().toString(36).slice(2)}`;
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', heading.id);
      panel.tabIndex = -1; panel.append(heading); root.append(panel);
      const previous = document.activeElement, inert = [];
      for (const sibling of [...document.body.children]) {
        if (!sibling.inert) { sibling.inert = true; inert.push(sibling); }
      }
      document.body.append(root); panel.focus();
      let closed = false;
      function close() {
        if (closed) return;
        closed = true; root.remove(); overlays.delete(teardown);
        for (const sibling of inert) sibling.inert = false;
        previous?.isConnected && previous.focus?.();
      }
      const teardown = () => { cancelled?.(true); close(); };
      overlays.add(teardown);
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); cancelled?.(); }
        if (event.key !== 'Tab') return;
        const controls = [...panel.querySelectorAll('button,input,a[href],[tabindex="0"]')].filter(node => !node.disabled && !node.hidden);
        if (!controls.length) { event.preventDefault(); panel.focus(); return; }
        if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel)) {
          event.preventDefault(); controls.at(-1).focus();
        } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
      });
      return { root, panel, close };
    }
    function registerFile(blob, original = false) {
      const path = URL.createObjectURL(blob);
      files.set(path, { blob, original });
      return path;
    }
    function getFile(path) {
      const file = files.get(path);
      if (!file) throw new Error('ENOENT: file not exist');
      return file;
    }
    function removeFile(path) {
      if (!files.has(path)) return false;
      files.delete(path); URL.revokeObjectURL(path); return true;
    }
    function clearImages() { imageEpoch += 1; for (const path of [...files.keys()]) removeFile(path); }
    function imageFor(path) {
      getFile(path);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img); img.onerror = () => reject(new Error('图片读取失败。')); img.src = path;
      });
    }
    async function imageType(blob) {
      const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
      if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'png';
      throw new Error('请选择 JPG 或 PNG 截图。');
    }
    async function inspectImage(path) {
      const { blob } = getFile(path);
      if (blob.size < 1 || blob.size > MAX_SOURCE_BYTES) throw new Error('截图需小于12 MiB。');
      const type = await imageType(blob), image = await imageFor(path);
      if (image.naturalWidth * image.naturalHeight > MAX_PIXELS) throw new Error('截图需小于1600万像素。');
      return { width: image.naturalWidth, height: image.naturalHeight, type, orientation: 'up', path };
    }
    function blobFromCanvas(canvas, type, quality) {
      return new Promise((resolve, reject) => {
        try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败。')), type, quality); }
        catch (_) { reject(new Error('图片导出失败。')); }
      });
    }
    function fsTask(options, api, work) {
      Promise.resolve().then(work).then(value => response(options, true, value), error => response(options, false, problem(api, error.message)));
    }
    const fs = {
      stat(options) { fsTask(options, 'stat', () => ({ stats: { size: getFile(options.path).blob.size } })); },
      access(options) { fsTask(options, 'access', () => { getFile(options.path); return { errMsg: 'access:ok' }; }); },
      unlink(options) { fsTask(options, 'unlink', () => { if (!removeFile(options.filePath)) throw new Error('ENOENT: file not exist'); return { errMsg: 'unlink:ok' }; }); },
      readFile(options) {
        fsTask(options, 'readFile', async () => {
          const { blob } = getFile(options.filePath);
          const start = options.position === undefined ? 0 : options.position;
          const length = options.length === undefined ? blob.size - start : options.length;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > blob.size) throw new Error('读取范围无效。');
          const buffer = await blob.slice(start, start + length).arrayBuffer();
          if (options.encoding === 'base64') {
            const bytes = new Uint8Array(buffer), chunks = [];
            for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
            return { data: global.btoa(chunks.join('')) };
          }
          if (options.encoding) throw new Error('不支持的编码。');
          return { data: buffer };
        });
      },
    };
    const wx = {
      env: { USER_DATA_PATH: 'memory://eatwhat-web' },
      getStorageSync(key) {
        const raw = storage().getItem(STORAGE_PREFIX + key);
        return raw === null ? '' : JSON.parse(raw);
      },
      setStorageSync(key, value) {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error('不能保存未定义值。');
        storage().setItem(STORAGE_PREFIX + key, serialized);
      },
      removeStorageSync(key) { storage().removeItem(STORAGE_PREFIX + key); },
      getStorageInfoSync() {
        const target = storage(), keys = []; let bytes = 0;
        for (let i = 0; i < target.length; i += 1) {
          const key = target.key(i);
          if (!key.startsWith(STORAGE_PREFIX)) continue;
          keys.push(key.slice(STORAGE_PREFIX.length)); bytes += new TextEncoder().encode(key + target.getItem(key)).length;
        }
        return { keys, currentSize: Math.ceil(bytes / 1024), limitSize: 5120 };
      },
      request(options = {}) {
        const controller = new AbortController(); let settled = false, timer, timedOut = false;
        const finish = (successful, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); activeRequests.delete(abort); response(options, successful, value);
        };
        const abort = () => { controller.abort(); finish(false, problem('request', timedOut ? 'timeout' : 'abort')); };
        activeRequests.add(abort);
        queueMicrotask(async () => {
          if (settled) return;
          try {
            const path = apiPath(options.url), method = (options.method || 'GET').toUpperCase();
            if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || method === 'GET' && options.data !== undefined) throw new Error('请求方式无效。');
            if (options.data?.device?.platform === 'MINIPROGRAM') throw new Error('网页版账号需要 WEB 平台支持。');
            const headers = {};
            for (const [key, value] of Object.entries(options.header || {})) {
              if (!['authorization', 'content-type', 'accept', 'x-chishenme-contract-version'].includes(key.toLowerCase())) throw new Error('请求头未获允许。');
              headers[key] = String(value);
            }
            const timeout = Number.isFinite(options.timeout) ? Math.max(1, Math.min(options.timeout, 120000)) : 15000;
            timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
            const result = await global.fetch(path, { method, headers,
              body: options.data === undefined ? undefined : JSON.stringify(options.data),
              signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
            const header = {};
            result.headers.forEach((value, key) => { header[key] = value; });
            let data;
            if (options.responseType === 'arraybuffer') data = await result.arrayBuffer();
            else {
              const raw = await result.text();
              if (options.dataType === 'json' || options.dataType === undefined) {
                try { data = raw ? JSON.parse(raw) : null; }
                catch (_) { throw new Error('服务响应不是有效 JSON。'); }
              } else data = raw;
            }
            if (path === '/api/v1/config' && result.status === 200) data = browserCapabilities(data);
            finish(true, { statusCode: result.status, header, data, errMsg: 'request:ok' });
          } catch (error) {
            finish(false, problem('request', controller.signal.aborted ? timedOut ? 'timeout' : 'abort' : error.message || '网络请求失败。'));
          }
        });
        return { abort };
      },
      navigateTo(options = {}) { finishRoute(options, 'navigateTo'); },
      redirectTo(options = {}) { finishRoute(options, 'redirectTo'); },
      reLaunch(options = {}) { finishRoute(options, 'reLaunch'); },
      navigateBack(options = {}) {
        const leavingImages = runtime.currentPages().at(-1)?.route === 'pages/takeout/index';
        try {
          Promise.resolve(runtime.back(options.delta || 1)).then(() => {
            if (leavingImages && !runtime.currentPages().some(page => page.route === 'pages/takeout/index')) clearImages();
            response(options, true, { errMsg: 'navigateBack:ok' });
          }, () => response(options, false, problem('navigateBack', '返回失败。')));
        } catch (_) { asyncResponse(options, false, problem('navigateBack', '返回失败。')); }
      },
      setNavigationBarTitle(options = {}) { runtime.setTitle(options.title || '吃什么'); asyncResponse(options, true, {}); },
      setNavigationBarColor(options = {}) { runtime.setNavColor(options); asyncResponse(options, true, {}); },
      hideShareMenu(options = {}) { asyncResponse(options, true, { errMsg: 'hideShareMenu:ok' }); },
      nextTick(callback) { queueMicrotask(() => { runtime.flush?.(); global.requestAnimationFrame(() => callback?.()); }); },
      createSelectorQuery() { return runtime.createSelectorQuery(); },
      getAppBaseInfo() { return { theme: theme.matches ? 'dark' : 'light', platform: 'web' }; },
      getWindowInfo() {
        const root = document.querySelector('#ew-app');
        const width = root?.clientWidth || global.innerWidth;
        const navigationHeight = global.document?.querySelector('.ew-navigation')?.getBoundingClientRect().height || 48;
        const height = Math.max(1, (global.visualViewport?.height || global.innerHeight) - navigationHeight);
        return { windowWidth: width, windowHeight: height, screenWidth: global.screen.width, screenHeight: global.screen.height,
          pixelRatio: global.devicePixelRatio || 1, statusBarHeight: 0, safeArea: { left: 0, top: 0, right: width, bottom: height, width, height } };
      },
      onThemeChange(listener) { if (typeof listener === 'function') themeListeners.add(listener); },
      offThemeChange(listener) { themeListeners.delete(listener); },
      getRandomValues(options = {}) {
        try {
          if (!Number.isInteger(options.length) || options.length < 1 || options.length > 65536) throw new Error('随机字节长度无效。');
          const bytes = new Uint8Array(options.length); global.crypto.getRandomValues(bytes);
          asyncResponse(options, true, { randomValues: bytes.buffer });
        } catch (_) { asyncResponse(options, false, problem('getRandomValues', '安全随机源不可用。')); }
      },
      getSetting(options = {}) {
        locationState().then(value => response(options, true, { authSetting: { 'scope.userLocation': value === 'granted' ? true : value === 'denied' ? false : undefined } }),
          () => response(options, false, problem('getSetting', '权限状态不可用。')));
      },
      getLocation(options = {}) {
        if (!navigator.geolocation) { asyncResponse(options, false, problem('getLocation', '浏览器不支持定位。')); return; }
        if (options.type && !['wgs84', 'gcj02'].includes(options.type)) { asyncResponse(options, false, problem('getLocation', '坐标系无效。')); return; }
        navigator.geolocation.getCurrentPosition(position => {
          locationPermission = 'granted';
          const c = position.coords;
          const coordinates = options.type === 'gcj02' ? toGcj02(c.latitude, c.longitude) : { latitude: c.latitude, longitude: c.longitude };
          response(options, true, { ...coordinates, accuracy: c.accuracy, altitude: c.altitude || 0, speed: c.speed || 0,
            horizontalAccuracy: c.accuracy, verticalAccuracy: c.altitudeAccuracy || 0, errMsg: 'getLocation:ok' });
        }, error => {
          if (error.code === 1) locationPermission = 'denied';
          response(options, false, problem('getLocation', error.code === 1 ? 'permission denied' : error.code === 3 ? 'timeout' : '位置暂时不可用。'));
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
      },
      getPrivacySetting(options = {}) {
        // There is no WeChat platform privacy dialog in a browser. This does
        // not accept the application's privacy policy or image upload consent;
        // the existing page requires both separately before any upload.
        asyncResponse(options, true, { needAuthorization: false, privacyContractName: '吃什么隐私说明' });
      },
      requirePrivacyAuthorize(options = {}) {
        // Read the user's existing choice, never create consent. Browser
        // geolocation still asks its own permission on the next explicit call.
        let accepted = false;
        try { accepted = wx.getStorageSync('eatwhat.wechat.consent.v2') === true; } catch (_) { /* Fail closed. */ }
        asyncResponse(options, accepted, accepted ? { errMsg: 'requirePrivacyAuthorize:ok' } : problem('requirePrivacyAuthorize', 'privacy denied: 请先阅读并同意应用隐私说明。'));
      },
      openPrivacyContract(options = {}) { finishRoute({ ...options, url: '/pages/privacy/index' }, 'navigateTo'); },
      openSetting(options = {}) {
        wx.showModal({ title: '浏览器位置权限', content: '点击地址栏旁的网站权限图标，将“位置”设为允许，再返回重试。手机也可能需要在系统设置中为浏览器开启位置权限。', showCancel: false, confirmText: '知道了',
          success: () => wx.getSetting(options), fail: value => response(options, false, value) });
      },
      login(options = {}) { asyncResponse(options, false, problem('login', '浏览器不支持小程序微信登录，请使用手机号或邮箱。')); },
      showToast(options = {}) {
        installStyles(); clearTimeout(toastTimer); toast?.remove();
        toast = make('div', String(options.title || ''), 'ew-toast'); toast.setAttribute('role', 'status'); document.body.append(toast);
        toastTimer = setTimeout(() => { toast?.remove(); toast = null; }, Math.max(1200, Math.min(options.duration || 2200, 10000)));
        asyncResponse(options, true, { errMsg: 'showToast:ok' });
      },
      hideToast() { clearTimeout(toastTimer); toast?.remove(); toast = null; },
      showModal(options = {}) {
        let completed = false, input;
        const finish = confirmed => {
          if (completed) return; completed = true;
          const content = input?.value;
          ui.close(); response(options, true, { confirm: confirmed, cancel: !confirmed, ...(content === undefined ? {} : { content }) });
        };
        const ui = dialog(options.title || '提示', () => { if (options.showCancel !== false) finish(false); });
        ui.panel.append(make('p', options.content || '', 'ew-dialog-copy'));
        if (options.editable) { input = make('input', undefined, 'ew-dialog-input'); input.value = options.content || ''; input.placeholder = options.placeholderText || ''; ui.panel.append(input); }
        const actions = make('div', undefined, 'ew-dialog-actions');
        if (options.showCancel !== false) { const cancel = make('button', options.cancelText || '取消'); cancel.onclick = () => finish(false); actions.append(cancel); }
        const confirm = make('button', options.confirmText || '确定', 'ew-confirm');
        if (/^#[0-9a-f]{6}$/i.test(options.confirmColor || '')) confirm.style.backgroundColor = options.confirmColor;
        confirm.onclick = () => finish(true); actions.append(confirm); ui.panel.append(actions);
        (input || actions.querySelector('button'))?.focus();
      },
      showActionSheet(options = {}) {
        let done = false;
        const finish = index => {
          if (done) return; done = true; ui.close();
          response(options, index >= 0, index >= 0 ? { tapIndex: index } : problem('showActionSheet', 'cancel'));
        };
        const ui = dialog(options.title || '请选择', () => finish(-1));
        const list = make('div', undefined, 'ew-action-list');
        (options.itemList || []).forEach((label, index) => { const button = make('button', String(label)); button.onclick = () => finish(index); list.append(button); });
        const cancel = make('button', '取消'); cancel.onclick = () => finish(-1); list.append(cancel); ui.panel.append(list); list.querySelector('button')?.focus();
      },
      setClipboardData(options = {}) {
        Promise.resolve().then(() => navigator.clipboard.writeText(String(options.data || ''))).then(() => {
          response(options, true, { errMsg: 'setClipboardData:ok' }); wx.showToast({ title: '已复制' });
        }, () => response(options, false, problem('setClipboardData', '浏览器未允许复制，请手动复制。')));
      },
      makePhoneCall(options = {}) {
        const phone = String(options.phoneNumber || '');
        if (!/^\+?[0-9 -]{3,30}$/.test(phone)) { asyncResponse(options, false, problem('makePhoneCall', '电话号码无效。')); return; }
        const anchor = make('a'); anchor.href = `tel:${phone.replace(/[ -]/g, '')}`; anchor.click();
        asyncResponse(options, true, { errMsg: 'makePhoneCall:ok' });
      },
      openLocation(options = {}) {
        if (!Number.isFinite(options.latitude) || Math.abs(options.latitude) > 90 || !Number.isFinite(options.longitude) || Math.abs(options.longitude) > 180) {
          asyncResponse(options, false, problem('openLocation', '目的地无效。')); return;
        }
        // Official AMap URI endpoint; only an explicit navigation action opens
        // the destination. No API keys, GPS origin or login data are included.
        const params = new URLSearchParams({ position: `${options.longitude},${options.latitude}`, name: String(options.name || '餐厅').slice(0, 80),
          src: 'eatwhat.pro', coordinate: 'gaode', callnative: '0' });
        const opened = global.open(`https://uri.amap.com/marker?${params}`, '_blank');
        if (opened) { opened.opener = null; asyncResponse(options, true, { errMsg: 'openLocation:ok' }); }
        else asyncResponse(options, false, problem('openLocation', '浏览器阻止了地图窗口，请允许弹出窗口后重试。'));
      },
      getFileSystemManager() { return fs; },
      // Web-only compile-time hook called after the unchanged page clears its
      // image processor. Releasing a File/Blob reference never changes the
      // user's original disk file. Safe to call again after native cleanup.
      releaseImageFiles() {
        const released = files.size;
        for (const cancel of [...activePickers]) cancel();
        clearImages();
        return { released, remaining: files.size };
      },
      getImageInfo(options = {}) {
        inspectImage(options.src).then(value => response(options, true, value), error => response(options, false, problem('getImageInfo', error.message)));
      },
      chooseMedia(options = {}) {
        const input = make('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png'; input.multiple = (options.count || 1) > 1;
        input.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px'; document.body.append(input);
        let done = false, selected = false, cancelTimer;
        const epoch = imageEpoch;
        const finish = (successful, value) => {
          if (done) return; done = true; clearTimeout(cancelTimer); activePickers.delete(cancelPicker); global.removeEventListener('focus', focused); input.remove(); response(options, successful, value);
        };
        const cancelPicker = () => finish(false, problem('chooseMedia', 'cancel'));
        activePickers.add(cancelPicker);
        const focused = () => { cancelTimer = setTimeout(() => { if (!selected && !input.files?.length) finish(false, problem('chooseMedia', 'cancel')); }, 600); };
        input.addEventListener('cancel', () => finish(false, problem('chooseMedia', 'cancel')));
        input.addEventListener('change', async () => {
          selected = true; const picked = [...input.files], registered = [];
          if (!picked.length) { finish(false, problem('chooseMedia', 'cancel')); return; }
          if (picked.length > Math.min(options.count || 1, 3)) { finish(false, problem('chooseMedia', '最多选择3张截图，请重新选择。')); return; }
          try {
            for (const file of picked) {
              if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw new Error('每张截图需小于12 MiB。');
              const path = registerFile(file, true); registered.push(path); await inspectImage(path);
            }
            if (done || epoch !== imageEpoch) throw new Error('cancel');
            for (const [path, file] of [...files]) if (file.original && !registered.includes(path)) removeFile(path);
            finish(true, { type: 'image', tempFiles: registered.map(path => ({ tempFilePath: path, size: getFile(path).blob.size, fileType: 'image' })) });
          } catch (error) { registered.forEach(removeFile); finish(false, problem('chooseMedia', error.message)); }
        });
        global.addEventListener('focus', focused, { once: true });
        try { input.click(); } catch (_) { finish(false, problem('chooseMedia', '无法打开图片选择器。')); }
      },
      previewImage(options = {}) {
        const paths = options.urls || [];
        if (!paths.length || paths.some(path => !files.has(path))) { asyncResponse(options, false, problem('previewImage', '本次图片已释放，请重新选择。')); return; }
        let index = Math.max(0, paths.indexOf(options.current));
        const close = () => { ui.close(); response(options, true, { errMsg: 'previewImage:ok' }); };
        const ui = dialog('截图预览', close), image = make('img', undefined, 'ew-preview-image'); image.alt = '本次选择的截图';
        const nav = make('div', undefined, 'ew-image-nav'), previous = make('button', '上一张'), position = make('span'), next = make('button', '下一张');
        const render = () => { image.src = paths[index]; position.textContent = `${index + 1} / ${paths.length}`; previous.disabled = index === 0; next.disabled = index === paths.length - 1; };
        previous.onclick = () => { index -= 1; render(); }; next.onclick = () => { index += 1; render(); };
        nav.append(previous, position, next); ui.panel.append(image, nav);
        const actions = make('div', undefined, 'ew-dialog-actions'), done = make('button', '完成', 'ew-confirm'); done.onclick = close; actions.append(done); ui.panel.append(actions); render(); done.focus();
      },
      editImage(options = {}) {
        const epoch = imageEpoch;
        inspectImage(options.src).then(info => {
          if (epoch !== imageEpoch) { response(options, false, problem('editImage', 'cancel')); return; }
          let done = false, saving = false, start = null, selection = { x: 0, y: 0, width: 1, height: 1 };
          const finish = (successful, value) => { if (done) return; done = true; ui.close(); response(options, successful, value); };
          const ui = dialog('裁剪截图', force => { if (force || !saving) finish(false, problem('editImage', 'cancel')); });
          ui.panel.append(make('p', '拖动选择保留区域。键盘方向键移动，Shift＋方向键调整大小。仅生成临时副本，不修改原图。', 'ew-dialog-copy'));
          const stage = make('div', undefined, 'ew-crop-stage'), img = make('img'), rectangle = make('div', undefined, 'ew-crop-selection');
          stage.tabIndex = 0; stage.setAttribute('role', 'group'); stage.setAttribute('aria-label', '截图裁剪区域，方向键移动，Shift加方向键调整大小');
          img.src = options.src; img.alt = '拖动选择截图裁剪区域'; stage.append(img, rectangle); ui.panel.append(stage);
          // The stage follows the image aspect ratio so pointer coordinates
          // cannot accidentally include object-fit letterboxing.
          stage.style.width = '100%'; stage.style.aspectRatio = `${info.width} / ${info.height}`;
          stage.style.maxHeight = '55dvh'; stage.style.maxWidth = `calc(55dvh * ${info.width / info.height})`; stage.style.marginInline = 'auto';
          img.style.cssText = 'width:100%;height:100%;object-fit:fill;max-height:none';
          function present() {
            rectangle.style.cssText = `left:${selection.x * 100}%;top:${selection.y * 100}%;width:${selection.width * 100}%;height:${selection.height * 100}%`;
          }
          function point(event) { const box = stage.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }; }
          stage.addEventListener('pointerdown', event => { if (saving) return; start = point(event); stage.setPointerCapture(event.pointerId); });
          stage.addEventListener('pointermove', event => { if (!start || saving) return; const end = point(event); selection = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) }; present(); });
          stage.addEventListener('pointerup', () => { start = null; if (selection.width < 0.01 || selection.height < 0.01) { selection = { x: 0, y: 0, width: 1, height: 1 }; present(); } });
          stage.addEventListener('pointercancel', () => { start = null; });
          const note = make('p', '', 'ew-crop-note'); note.setAttribute('role', 'status'); ui.panel.append(note);
          stage.addEventListener('keydown', event => {
            if (saving || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const dx = event.key === 'ArrowLeft' ? -0.02 : event.key === 'ArrowRight' ? 0.02 : 0;
            const dy = event.key === 'ArrowUp' ? -0.02 : event.key === 'ArrowDown' ? 0.02 : 0;
            if (event.shiftKey) {
              selection.width = Math.max(0.02, Math.min(1 - selection.x, selection.width + dx));
              selection.height = Math.max(0.02, Math.min(1 - selection.y, selection.height + dy));
            } else {
              selection.x = Math.max(0, Math.min(1 - selection.width, selection.x + dx));
              selection.y = Math.max(0, Math.min(1 - selection.height, selection.y + dy));
            }
            present(); note.textContent = `保留原图宽度 ${Math.round(selection.width * 100)}%、高度 ${Math.round(selection.height * 100)}%。`;
          });
          const actions = make('div', undefined, 'ew-dialog-actions'), cancel = make('button', '取消'), reset = make('button', '保留整图'), save = make('button', '保存副本', 'ew-confirm');
          cancel.onclick = () => finish(false, problem('editImage', 'cancel'));
          reset.onclick = () => { selection = { x: 0, y: 0, width: 1, height: 1 }; present(); };
          save.onclick = async () => {
            if (saving) return; saving = true; cancel.disabled = reset.disabled = save.disabled = true; note.textContent = '正在生成副本…';
            try {
              // WebKit may not have decoded the newly displayed <img> yet,
              // even when a separate metadata image has already loaded.
              if (typeof img.decode === 'function') await img.decode();
              else if (!img.complete) await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
              if (done || epoch !== imageEpoch) throw new Error('cancel');
              const canvas = document.createElement('canvas');
              const x = Math.floor(selection.x * info.width), y = Math.floor(selection.y * info.height);
              canvas.width = Math.max(1, Math.min(info.width - x, Math.round(selection.width * info.width)));
              canvas.height = Math.max(1, Math.min(info.height - y, Math.round(selection.height * info.height)));
              const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(img, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
              const blob = await blobFromCanvas(canvas, 'image/jpeg', 0.94); canvas.width = canvas.height = 1;
              if (done || epoch !== imageEpoch) throw new Error('cancel');
              const path = registerFile(blob); finish(true, { tempFilePath: path });
            } catch (error) { saving = false; cancel.disabled = reset.disabled = save.disabled = false; note.textContent = error.message === 'cancel' ? '图片操作已取消，请返回重新选择。' : '未能保存，请重试。'; }
          };
          actions.append(cancel, reset, save); ui.panel.append(actions); present(); save.focus();
        }, error => response(options, false, problem('editImage', error.message)));
      },
      canvasToTempFilePath(options = {}) {
        const epoch = imageEpoch;
        Promise.resolve().then(async () => {
          const canvas = options.canvas;
          if (!canvas || typeof canvas.toBlob !== 'function') throw new Error('画布不可用。');
          let output = canvas;
          const width = options.destWidth || options.width || canvas.width, height = options.destHeight || options.height || canvas.height;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error('画布尺寸无效。');
          if (options.x || options.y || width !== canvas.width || height !== canvas.height) {
            output = document.createElement('canvas'); output.width = width; output.height = height;
            output.getContext('2d').drawImage(canvas, options.x || 0, options.y || 0, options.width || canvas.width, options.height || canvas.height, 0, 0, width, height);
          }
          const blob = await blobFromCanvas(output, options.fileType === 'png' ? 'image/png' : 'image/jpeg', options.quality ?? 0.92);
          if (output !== canvas) output.width = output.height = 1;
          if (epoch !== imageEpoch) throw new Error('cancel');
          return { tempFilePath: registerFile(blob) };
        }).then(value => response(options, true, value), error => response(options, false, problem('canvasToTempFilePath', error.message)));
      },
    };
    theme.addEventListener('change', () => { for (const listener of themeListeners) listener({ theme: theme.matches ? 'dark' : 'light' }); });
    global.addEventListener('popstate', () => queueMicrotask(() => {
      if (!runtime.currentPages().some(page => page.route === 'pages/takeout/index')) clearImages();
    }));
    global.addEventListener('pagehide', () => {
      for (const abort of [...activeRequests]) abort();
      for (const cancel of [...activePickers]) cancel();
      for (const close of [...overlays]) close();
      // A bfcache return retains JS objects. Clear source-level previews as well
      // as object URLs so returning never displays already-revoked images.
      try { runtime.app?.()?.clearTakeoutState?.(); } catch (_) { /* URLs are still released below. */ }
      clearImages(); wx.hideToast();
    });
    global.wx = wx;
    return wx;
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { apiPath, browserCapabilities, toGcj02, STORAGE_PREFIX };
})(typeof window !== 'undefined' ? window : globalThis);
