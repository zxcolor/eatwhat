// UUIDs identify retries, never authentication. Fail closed if platform entropy is unavailable.
function uuid() {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('无法创建提交标识，请更新微信后重试。'));
    try {
      wx.getRandomValues({ length: 16, fail, success(value) {
        try {
          const bytes = new Uint8Array(value.randomValues);
          if (bytes.length !== 16) return fail();
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
          resolve(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
        } catch (_) { fail(); }
      } });
    } catch (_) { fail(); }
  });
}
module.exports = { uuid };
