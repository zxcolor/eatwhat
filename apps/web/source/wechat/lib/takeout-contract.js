// Keep these public limits aligned with packages/contracts/src/takeout.ts.
const CONSENT_VERSION = 'takeout-screenshot-v1';
const MODEL = 'mimo-v2.6-flash';
const NOTICE = 'SCREENSHOT_TEXT_REQUIRES_CONFIRMATION';
const LIMITS = Object.freeze({ maxImages: 3, maxImageBytes: 768 * 1024,
  maxTotalImageBytes: 2 * 1024 * 1024, maxImageWidth: 1280, maxImageHeight: 2400,
  maxImagePixels: 3072000, maxTotalImagePixels: 9216000, maxCandidates: 20,
  maxReceiptBytes: 64 * 1024, receiptTtlMs: 600000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const IMAGE_ID = /^image-[1-3]$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RECEIPT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REASONS = ['UNAVAILABLE', 'CAPACITY', 'INVALID_MODEL_RESULT', 'SINGLE_CANDIDATE', 'NO_CANDIDATES'];
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.keys(value).includes(key));
}
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function visible(value, limit) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code >= 127 && code <= 159;
  });
}
function nullableText(value, limit) { return value === null || visible(value, limit); }
function base64Bytes(value) { return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0); }
function validImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > LIMITS.maxImages) return false;
  const ids = new Set();
  let bytes = 0;
  for (const image of images) {
    if (!exact(image, ['imageId', 'mimeType', 'base64']) || !IMAGE_ID.test(image.imageId) || ids.has(image.imageId) ||
      !['image/jpeg', 'image/png'].includes(image.mimeType) || typeof image.base64 !== 'string' ||
      image.base64.length < 4 || image.base64.length > 4 * Math.ceil(LIMITS.maxImageBytes / 3) || !BASE64.test(image.base64)) return false;
    const size = base64Bytes(image.base64);
    if (!integer(size, 1, LIMITS.maxImageBytes)) return false;
    ids.add(image.imageId); bytes += size;
  }
  return bytes <= LIMITS.maxTotalImageBytes;
}
function validReceipt(value) { return typeof value === 'string' && value.length >= 80 && value.length <= LIMITS.maxReceiptBytes && RECEIPT.test(value); }
function validCandidate(value, imageIds) {
  if (!exact(value, ['id', 'kind', 'name', 'merchantName', 'visiblePriceText', 'visibleMetaText', 'imageId', 'bbox']) ||
    !UUID.test(value.id) || !['MERCHANT', 'DISH'].includes(value.kind) || !visible(value.name, 80) ||
    !nullableText(value.merchantName, 80) || !nullableText(value.visiblePriceText, 80) || !nullableText(value.visibleMetaText, 160) ||
    !imageIds.includes(value.imageId) || value.kind === 'MERCHANT' && value.merchantName !== null) return false;
  const box = value.bbox;
  return exact(box, ['x', 'y', 'width', 'height']) && integer(box.x, 0, 999) && integer(box.y, 0, 999) &&
    integer(box.width, 1, 1000) && integer(box.height, 1, 1000) && box.x + box.width <= 1000 && box.y + box.height <= 1000;
}
function validExtraction(value, requestId, imageIds) {
  if (!exact(value, ['requestId', 'status', 'candidates', 'receipt', 'expiresAt', 'source', 'model', 'notice']) ||
    value.requestId !== requestId || value.source !== 'MIMO' || value.model !== MODEL || value.notice !== NOTICE ||
    !Array.isArray(value.candidates) || value.candidates.length > LIMITS.maxCandidates ||
    new Set(value.candidates.map(item => item?.id)).size !== value.candidates.length ||
    !value.candidates.every(item => validCandidate(item, imageIds))) return false;
  if (value.status === 'NO_CANDIDATES') return value.candidates.length === 0 && value.receipt === null && value.expiresAt === null;
  const expires = typeof value.expiresAt === 'string' && ISO.test(value.expiresAt) ? Date.parse(value.expiresAt) : NaN;
  return value.status === 'READY' && value.candidates.length > 0 && validReceipt(value.receipt) &&
    Number.isFinite(expires);
}
function validPreferences(value) {
  return exact(value, ['spicyLevel', 'flavorIntensity']) && [0, 1, 3, 4, 6].includes(value.spicyLevel) && [0, 100].includes(value.flavorIntensity);
}
function validExclusions(ids, candidates) {
  return Array.isArray(ids) && ids.length <= LIMITS.maxCandidates && new Set(ids).size === ids.length &&
    ids.every(id => typeof id === 'string' && UUID.test(id) && candidates.some(item => item.id === id));
}
function validDecision(value, request, candidates) {
  if (!exact(value, ['requestId', 'preferenceRevision', 'status', 'selectedCandidateId', 'source', 'model', 'fallbackReason', 'notice']) ||
    value.requestId !== request.requestId || value.preferenceRevision !== request.preferenceRevision || value.notice !== NOTICE) return false;
  const available = candidates.filter(item => !request.excludedCandidateIds.includes(item.id));
  if (value.status === 'EXHAUSTED') return available.length === 0 && value.selectedCandidateId === null &&
    value.source === 'LOCAL' && value.model === null && value.fallbackReason === 'NO_CANDIDATES';
  if (value.status !== 'SELECTED' || !available.some(item => item.id === value.selectedCandidateId)) return false;
  return value.source === 'MIMO' ? value.model === MODEL && value.fallbackReason === null
    : value.source === 'LOCAL' && value.model === null && REASONS.includes(value.fallbackReason) &&
      value.fallbackReason !== 'NO_CANDIDATES' && (value.fallbackReason !== 'SINGLE_CANDIDATE' || available.length === 1);
}
module.exports = { CONSENT_VERSION, MODEL, NOTICE, LIMITS, REQUEST_ID, exact, integer,
  base64Bytes, validImages, validReceipt, validCandidate, validExtraction, validPreferences, validExclusions, validDecision };
