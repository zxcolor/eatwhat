// A verified export is read in memory only. No file, clipboard or web URL is created.
const MAX_BYTES = 10485760
const PAGE_CHARS = 16000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
function invalid() { const error = new Error('导出内容未通过完整性校验，请刷新状态后重试'); error.code = 'INVALID_RESPONSE'; throw error }
function has(value, key) { return Object.keys(value).includes(key) }
function exact(value, keys, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value) && keys.every(key => has(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
}
function instant(value) { return typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN }
function validStatus(value, now, expectedId) {
  const base = ['exportId', 'status', 'requestedAt', 'expiresAt', 'includeBehaviorHistory', 'downloadAvailable']
  if (!value || !ID.test(value.exportId) || expectedId && value.exportId !== expectedId || typeof value.includeBehaviorHistory !== 'boolean') return false
  const requested = instant(value.requestedAt), expires = instant(value.expiresAt)
  if (!(requested <= now + 30000 && expires > requested && expires <= requested + 604830000)) return false
  if (['QUEUED', 'PROCESSING', 'EXPIRED'].includes(value.status)) return exact(value, base) && value.downloadAvailable === false
  if (value.status === 'FAILED') return exact(value, [...base, 'failureCode']) && value.failureCode === 'GENERATION_FAILED' && value.downloadAvailable === false
  if (value.status !== 'READY') return false
  const ready = instant(value.readyAt)
  return exact(value, [...base, 'readyAt', 'sizeBytes', 'sha256', 'contentType']) && value.downloadAvailable === true && ready >= requested && ready < expires && ready <= now + 30000 && expires > now && Number.isInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= MAX_BYTES && /^[0-9a-f]{64}$/.test(value.sha256) && value.contentType === 'application/json'
}
function validReceipt(value, now, include) {
  return exact(value, ['exportId', 'status', 'requestedAt', 'expiresAt', 'includeBehaviorHistory']) && value.status === 'QUEUED' && value.includeBehaviorHistory === include && instant(value.expiresAt) > now && validStatus({ ...value, downloadAvailable: false }, now)
}
function base64Hex(hex) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = hex.match(/../g).map(value => parseInt(value, 16))
  let value = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0)
    value += alphabet[n >>> 18] + alphabet[n >>> 12 & 63] + (i + 1 < bytes.length ? alphabet[n >>> 6 & 63] : '=') + (i + 2 < bytes.length ? alphabet[n & 63] : '=')
  }
  return value
}
function validHeaders(headers, status) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false
  const normalized = Object.create(null)
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase()
    if (has(normalized, lower) || typeof headers[key] !== 'string') return false
    normalized[lower] = headers[key]
  }
  return normalized['content-type']?.toLowerCase() === 'application/json; charset=utf-8' && normalized['content-length'] === String(status.sizeBytes) && normalized['x-content-sha256'] === status.sha256 && normalized.digest === `sha-256=${base64Hex(status.sha256)}` && normalized['content-disposition'] === 'attachment; filename="chi-shen-me-account-export.json"' && normalized['cache-control']?.toLowerCase() === 'private, no-store' && !has(normalized, 'content-encoding')
}
function rotate(value, bits) { return value >>> bits | value << (32 - bits) }
async function sha256(bytes, check = () => {}) {
  const length = bytes.length
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64)
  padded.set(bytes); padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000))
  view.setUint32(padded.length - 4, length * 8 >>> 0)
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const w = new Uint32Array(64)
  try {
    for (let offset = 0; offset < padded.length; offset += 64) {
      if (offset % 262144 === 0) { check(); if (offset) await new Promise(resolve => setTimeout(resolve, 0)); check() }
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
      for (let i = 16; i < 64; i += 1) {
        const x = w[i - 15], y = w[i - 2]
        w[i] = w[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3) + w[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10) >>> 0
      }
      let [a,b,c,d,e,f,g,j] = h
      for (let i = 0; i < 64; i += 1) {
        const first = j + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i] >>> 0
        const second = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c)) >>> 0
        j = g; g = f; f = e; e = d + first >>> 0; d = c; c = b; b = a; a = first + second >>> 0
      }
      ;[a,b,c,d,e,f,g,j].forEach((value, i) => { h[i] = h[i] + value >>> 0 })
    }
    check()
    return h.map(value => value.toString(16).padStart(8, '0')).join('')
  } finally { padded.fill(0); w.fill(0) }
}
function decodeUtf8(bytes) {
  const parts = []; let part = ''
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++]; let point, rest, minimum
    if (first < 0x80) { point = first; rest = 0; minimum = 0 }
    else if (first >= 0xc2 && first <= 0xdf) { point = first & 31; rest = 1; minimum = 0x80 }
    else if (first >= 0xe0 && first <= 0xef) { point = first & 15; rest = 2; minimum = 0x800 }
    else if (first >= 0xf0 && first <= 0xf4) { point = first & 7; rest = 3; minimum = 0x10000 }
    else invalid()
    if (i + rest > bytes.length) invalid()
    for (let j = 0; j < rest; j += 1) { const next = bytes[i++]; if ((next & 0xc0) !== 0x80) invalid(); point = point << 6 | next & 63 }
    if (point < minimum || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) invalid()
    part += String.fromCodePoint(point)
    if (part.length >= 8192) { parts.push(part); part = '' }
  }
  return parts.join('') + part
}
function validSnapshot(value, userId, include) {
  const timestamp = value => Number.isFinite(instant(value))
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  const list = (items, max, validate) => Array.isArray(items) && items.length <= max && items.every(validate)
  if (!exact(value, ['schemaVersion', 'generatedAt', 'account', 'identities', 'favorites', 'recommendationHistory', 'privateFeedback', 'supportFeedback', 'preferences'], ['canteenRatings']) || value.schemaVersion !== 1 || !timestamp(value.generatedAt)) return false
  if (!exact(value.account, ['accountId', 'status', 'createdAt']) || value.account.accountId !== userId || value.account.status !== 'ACTIVE' || !timestamp(value.account.createdAt) || !exact(value.preferences, [])) return false
  return list(value.identities, 32, item => exact(item, ['identityType', 'maskedDisplayHint', 'isPrimary', 'verifiedAt', 'createdAt'], ['revokedAt']) && ['PHONE', 'WECHAT', 'EMAIL', 'QQ', 'APPLE'].includes(item.identityType) && text(item.maskedDisplayHint, 254) && typeof item.isPrimary === 'boolean' && timestamp(item.verifiedAt) && timestamp(item.createdAt) && (!has(item, 'revokedAt') || timestamp(item.revokedAt))) &&
    list(value.favorites, 1000, item => exact(item, ['favoriteId', 'group', 'createdAt', 'placeReferenceAvailable']) && ID.test(item.favoriteId) && ['WANT_TO_GO', 'REGULAR'].includes(item.group) && timestamp(item.createdAt) && typeof item.placeReferenceAvailable === 'boolean') &&
    list(value.recommendationHistory, include ? 5000 : 0, item => exact(item, ['historyId', 'action', 'mealPeriod', 'occurredAt', 'placeReferenceAvailable']) && ID.test(item.historyId) && ['IMPRESSION', 'DETAIL', 'FAVORITE', 'NAVIGATION', 'CALL', 'REROLL'].includes(item.action) && ['BREAKFAST', 'LUNCH', 'DINNER'].includes(item.mealPeriod) && timestamp(item.occurredAt) && typeof item.placeReferenceAvailable === 'boolean') &&
    list(value.privateFeedback, include ? 2000 : 0, item => exact(item, ['feedbackId', 'type', 'createdAt', 'placeReferenceAvailable']) && ID.test(item.feedbackId) && ['WANT_TO_EAT', 'ATE', 'LIKE', 'DISLIKE', 'TOO_FAR', 'TOO_EXPENSIVE', 'ATE_RECENTLY', 'EXCLUDE_CUISINE'].includes(item.type) && timestamp(item.createdAt) && typeof item.placeReferenceAvailable === 'boolean') &&
    list(value.supportFeedback, 100, item => exact(item, ['feedbackId', 'category', 'status', 'createdAt', 'message'], ['closedAt']) && ID.test(item.feedbackId) && ['PRODUCT', 'PLACE_CORRECTION', 'PRIVACY', 'COMPLAINT'].includes(item.category) && ['OPEN', 'IN_REVIEW', 'CLOSED'].includes(item.status) && timestamp(item.createdAt) && (!has(item, 'closedAt') || timestamp(item.closedAt)) && text(item.message, 65536)) &&
    (!has(value, 'canteenRatings') || list(value.canteenRatings, 2000, item => exact(item, ['menuVersion', 'itemId', 'stallId', 'score', 'createdAt', 'updatedAt']) && text(item.menuVersion, 40) && /^canteen-menu-v[1-9][0-9]*$/.test(item.menuVersion) && text(item.itemId, 80) && /^[a-z][a-z0-9-]{1,79}$/.test(item.itemId) && text(item.stallId, 80) && /^[a-z][a-z0-9-]{1,79}$/.test(item.stallId) && Number.isInteger(item.score) && item.score >= 1 && item.score <= 5 && timestamp(item.createdAt) && timestamp(item.updatedAt) && instant(item.updatedAt) >= instant(item.createdAt)))
}
async function verifyContent(result, status, userId, check) {
  const buffer = result?.bytes
  if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') invalid()
  const bytes = new Uint8Array(buffer)
  try {
    check()
    if (bytes.length < 1 || bytes.length > MAX_BYTES || bytes.length !== status.sizeBytes || !validHeaders(result.headers, status)) invalid()
    if (await sha256(bytes, check) !== status.sha256) invalid()
    const text = decodeUtf8(bytes)
    let parsed
    try { parsed = JSON.parse(text) } catch (_) { invalid() }
    if (!validSnapshot(parsed, userId, status.includeBehaviorHistory)) invalid()
    check()
    return text
  } finally { bytes.fill(0) }
}
function page(text, index) {
  const total = Math.max(1, Math.ceil(text.length / PAGE_CHARS))
  const selected = Math.max(0, Math.min(total - 1, index))
  let start = selected * PAGE_CHARS, end = Math.min(text.length, start + PAGE_CHARS)
  if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start += 1
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end += 1
  return { text: text.slice(start, end), number: selected + 1, total }
}
module.exports = { MAX_BYTES, validStatus, validReceipt, validHeaders, sha256, decodeUtf8, validSnapshot, verifyContent, page }
