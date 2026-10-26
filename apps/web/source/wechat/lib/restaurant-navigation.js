const restaurants = require('./restaurant-presenter');

// Only the selected restaurant's destination is sent to the native map.
// Opening a map is not evidence that a route started or the user arrived.
function openRestaurantLocation(result, complete) {
  let settled = false;
  const finish = (successful, message = '') => {
    if (settled) return;
    settled = true;
    complete(successful, message);
  };
  if (!restaurants.actionsFor(result).canNavigate) {
    finish(false, '当前餐厅暂不支持导航。');
    return;
  }
  if (typeof wx.openLocation !== 'function') {
    finish(false, '当前微信暂不支持打开地图，请更新微信后重试。');
    return;
  }
  try {
    wx.openLocation({
      latitude: result.location.latitude, longitude: result.location.longitude,
      name: restaurants.inline(result.name), address: restaurants.inline(result.address), scale: 16,
      success: () => finish(true),
      fail: error => {
        const message = typeof error?.errMsg === 'string' ? error.errMsg : '';
        if (/cancel/i.test(message)) finish(false);
        else if (/auth|permission|privacy|scope/i.test(message)) finish(false, '地图未能打开，请检查微信的位置与隐私设置后重试。');
        else finish(false, '暂时无法打开地图，请稍后重试。');
      },
    });
  } catch (_) { finish(false, '暂时无法打开地图，请稍后重试。'); }
}

module.exports = { openRestaurantLocation };
