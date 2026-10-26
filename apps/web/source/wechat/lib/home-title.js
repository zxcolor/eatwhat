// Beijing stays at UTC+8, independently of the device's configured time zone.
function getHomeTitle(timestamp) {
  const hour = new Date(timestamp + 8 * 60 * 60 * 1000).getUTCHours();
  const period = hour < 11 ? '早上' : hour < 17 ? '中午' : '晚上';
  return `今天${period}吃什么`;
}

module.exports = { getHomeTitle };
