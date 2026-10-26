const { LIMITS, base64Bytes, validImages } = require('./takeout-contract');
const sharedCleanup = require('./takeout-cleanup');
const SOURCE_LIMITS = Object.freeze({ maxFiles: 3, maxBytes: 12 * 1024 * 1024, maxPixels: 16000000, overlap: 128 });
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function cancelled() { return failure('CANCELLED', '图片处理已取消。'); }
function localPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 2048 && !Array.from(path).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) &&
    (!/^https?:\/\//i.test(path) || /^https?:\/\/(?:tmp|usr)\//i.test(path));
}
function sourceMetadata(info, bytes, path) {
  if (!localPath(path) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > SOURCE_LIMITS.maxBytes ||
    !Number.isSafeInteger(info?.width) || !Number.isSafeInteger(info?.height) || info.width < 1 || info.height < 1 ||
    !Number.isSafeInteger(info.width * info.height) || info.width * info.height > SOURCE_LIMITS.maxPixels) {
    throw failure('IMAGE_TOO_LARGE', '原截图过大，请先在相册中裁短；每张最多12 MiB、1600万像素。');
  }
  if (!['jpeg', 'png'].includes(info.type)) throw failure('INVALID_IMAGE', '请选择 JPG 或 PNG 截图。');
  return { path, bytes, width: info.width, height: info.height, orientation: info.orientation || 'up', type: info.type };
}
function planTiles(sources) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > SOURCE_LIMITS.maxFiles) {
    throw failure('INVALID_IMAGE', '请选择1至3张截图。');
  }
  const tiles = [];
  let pixels = 0;
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    sourceMetadata(source, source.bytes, source.path);
    if (source.orientation !== 'up') throw failure('IMAGE_ORIENTATION', '请先编辑并保存图片方向，再重新选择截图。');
    const scale = Math.min(1, LIMITS.maxImageWidth / source.width);
    const width = Math.max(1, Math.floor(source.width * scale));
    const fullHeight = Math.max(1, Math.ceil(source.height * scale));
    let y = 0;
    do {
      const height = Math.min(LIMITS.maxImageHeight, fullHeight - y);
      pixels += width * height;
      if (tiles.length >= LIMITS.maxImages || pixels > LIMITS.maxTotalImagePixels) {
        throw failure('TOO_MANY_TILES', '截图列表太长。请裁短或分段截图，使这次选择合计不超过3个片段；不会自动丢弃后半部分。');
      }
      tiles.push({ imageId: `image-${tiles.length + 1}`, sourceIndex, width, height,
        sourceY: y / scale, sourceHeight: Math.min(source.height - y / scale, height / scale) });
      if (y + height >= fullHeight) break;
      y += height - SOURCE_LIMITS.overlap;
    } while (y < fullHeight);
  }
  return tiles;
}
function createImageProcessor(options) {
  const api = options.wx || wx;
  let fs = null;
  try { if (typeof api.getFileSystemManager === 'function') fs = api.getFileSystemManager(); } catch (_) { /* Report support failure only after an explicit image action. */ }
  const cleanup = options.cleanup || sharedCleanup;
  const deleteFile = typeof fs?.unlink === 'function' ? fs.unlink.bind(fs) : null;
  const owned = new Set(), originals = new Set(), pending = new Set(), creating = new Set();
  let generation = 0, disposed = false, canvas = null, preparing = false;
  function check(started, isCurrent) { if (disposed || started !== generation || !isCurrent()) throw cancelled(); }
  function forget(paths) {
    return Promise.all(paths.map(path => {
      if (!owned.has(path) || originals.has(path)) return Promise.resolve(true);
      return cleanup.remove(path).then(success => { if (success) owned.delete(path); return success; });
    }));
  }
  function reserveGenerated() { const ticket = cleanup.reserve(deleteFile, { runtime: api, fs, allowMove: true }); creating.add(ticket); return ticket; }
  function abandonGenerated(ticket) { cleanup.abandon(ticket); creating.delete(ticket); }
  function own(path, protectedPaths = [], reservation) {
    if (!localPath(path) || originals.has(path) || protectedPaths.includes(path)) { if (reservation) abandonGenerated(reservation); return false; }
    const ticket = reservation || reserveGenerated();
    try { cleanup.commit(ticket, path); creating.delete(ticket); }
    catch (error) { abandonGenerated(ticket); throw error; }
    owned.add(path); return true;
  }
  function reportCleanup(results) {
    if (results.some(value => value === false)) { try { options.onCleanupFailure?.(); } catch (_) { /* Cleanup remains retryable in the registry. */ } }
  }
  function discardGenerated(path, protectedPaths = [], reservation) {
    try { if (own(path, protectedPaths, reservation)) void forget([path]).then(reportCleanup); }
    catch (_) { try { options.onCleanupFailure?.(); } catch (_) { /* Do not throw from a late native callback. */ } }
  }
  function call(start, capture, failed) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(stop);
        if (error) reject(error); else resolve(result);
      };
      const stop = () => finish(cancelled());
      const timer = setTimeout(() => finish(failure('IMAGE_PROCESSING', '图片处理超时，请裁短图片后重试。')), 15000);
      pending.add(stop);
      try {
        start({ success(result) {
          try { capture?.(result, settled); }
          catch (_) { finish(failure('IMAGE_PROCESSING', '图片处理未完成，请重试。')); return; }
          finish(null, result);
        }, fail() { failed?.(); finish(failure('IMAGE_PROCESSING', '图片处理未完成，请重新选择或编辑截图。')); } });
      } catch (_) { failed?.(); finish(failure('IMAGE_PROCESSING', '当前微信暂不能处理这张图片，请更新微信或重新截图。')); }
    });
  }
  async function stat(path) {
    if (!localPath(path)) throw failure('INVALID_IMAGE', '仅支持本次主动选择的本地截图。');
    const result = await call(callbacks => fs.stat({ path, recursive: false, ...callbacks }));
    if (Array.isArray(result.stats) || !Number.isSafeInteger(result.stats?.size) || result.stats.size < 1) {
      throw failure('INVALID_IMAGE', '无法读取截图文件。');
    }
    return result.stats.size;
  }
  async function inspect(path, isCurrent = () => true) {
    const started = generation;
    check(started, isCurrent);
    const bytes = await stat(path);
    check(started, isCurrent);
    if (bytes > SOURCE_LIMITS.maxBytes) throw failure('IMAGE_TOO_LARGE', '原截图超过12 MiB，请先裁短再选择。');
    const info = await call(callbacks => api.getImageInfo({ src: path, ...callbacks }));
    check(started, isCurrent);
    return sourceMetadata(info, bytes, path);
  }
  async function loadImage(path, started, isCurrent) {
    const image = canvas.createImage();
    try {
      await call(callbacks => {
        image.onload = () => callbacks.success({});
        image.onerror = callbacks.fail;
        image.src = path;
      });
    } finally { image.onload = null; image.onerror = null; }
    check(started, isCurrent);
    return image;
  }
  async function exportTile(tile, image, source, quality, started, isCurrent) {
    const reservation = reserveGenerated();
    try {
      canvas.width = tile.width; canvas.height = tile.height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, tile.width, tile.height);
      context.drawImage(image, 0, tile.sourceY, source.width, tile.sourceHeight, 0, 0, tile.width, tile.height);
    } catch (_) {
      abandonGenerated(reservation);
      throw failure('IMAGE_PROCESSING', '图片绘制未完成，请裁短后重试。');
    }
    const protectedPaths = [...originals, source.path];
    const result = await call(callbacks => api.canvasToTempFilePath({ canvas, x: 0, y: 0,
      width: tile.width, height: tile.height, destWidth: tile.width, destHeight: tile.height,
      fileType: 'jpg', quality, ...callbacks }, options.component), (value, late) => {
      if (!own(value?.tempFilePath, protectedPaths, reservation)) return;
      if (late || disposed || started !== generation || !isCurrent()) void forget([value.tempFilePath]).then(reportCleanup);
    }, () => abandonGenerated(reservation));
    check(started, isCurrent);
    if (!owned.has(result.tempFilePath)) throw failure('IMAGE_PROCESSING', '未取得可安全处理的截图副本。');
    return result.tempFilePath;
  }
  async function prepare(paths, isCurrent = () => true) {
    if (preparing) throw failure('BUSY', '图片仍在处理中。');
    preparing = true;
    const started = generation, made = [], images = [];
    try {
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > SOURCE_LIMITS.maxFiles) throw failure('INVALID_IMAGE', '请选择1至3张截图。');
      const sources = [];
      for (const path of paths) sources.push(await inspect(path, isCurrent));
      const plan = planTiles(sources);
      check(started, isCurrent);
      canvas = await options.getCanvas();
      check(started, isCurrent);
      if (!canvas || typeof canvas.createImage !== 'function' || typeof canvas.getContext !== 'function') {
        throw failure('IMAGE_PROCESSING', '当前微信不支持截图处理，请更新微信后重试。');
      }
      let totalBytes = 0;
      const tiles = [];
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
        const source = sources[sourceIndex];
        let image = await loadImage(source.path, started, isCurrent);
        for (const tile of plan.filter(value => value.sourceIndex === sourceIndex)) {
          let accepted = null;
          for (const quality of [0.86, 0.72]) {
            check(started, isCurrent);
            const path = await exportTile(tile, image, source, quality, started, isCurrent);
            made.push(path);
            const bytes = await stat(path);
            check(started, isCurrent);
            if (bytes <= LIMITS.maxImageBytes && totalBytes + bytes <= LIMITS.maxTotalImageBytes) {
              accepted = { ...tile, path, bytes }; break;
            }
            await forget([path]);
          }
          if (!accepted) throw failure('IMAGE_TOO_LARGE', '图片仍然过大，请裁短列表或减少截图后重试。');
          totalBytes += accepted.bytes; tiles.push(accepted);
        }
        image = null;
      }
      // Read only after every tile fits. Base64 never enters page data/storage.
      for (const tile of tiles) {
        check(started, isCurrent);
        const result = await call(callbacks => fs.readFile({ filePath: tile.path, encoding: 'base64',
          position: 0, length: tile.bytes, ...callbacks }));
        check(started, isCurrent);
        const base64 = result.data;
        if (typeof base64 !== 'string' || base64.length !== 4 * Math.ceil(tile.bytes / 3) || base64Bytes(base64) !== tile.bytes || !base64.startsWith('/9j/')) {
          throw failure('INVALID_IMAGE', '截图副本读取不完整，请重新识别。');
        }
        images.push({ imageId: tile.imageId, mimeType: 'image/jpeg', base64 });
      }
      if (!validImages(images)) throw failure('INVALID_IMAGE', '截图副本未通过大小或格式校验。');
      return { images, tiles: tiles.map(({ imageId, path, width, height }) => ({ imageId, path, width, height })) };
    } catch (error) {
      images.forEach(image => { image.base64 = ''; }); images.length = 0;
      await forget(made);
      throw error;
    } finally {
      if (canvas) { try { canvas.width = 1; canvas.height = 1; } catch (_) { /* A leaving page may have released its native canvas. */ } }
      canvas = null; preparing = false;
    }
  }
  function cancel() { generation += 1; for (const stop of [...pending]) stop(); }
  function clear() { cancel(); return forget([...owned]).then(results => results.concat([...creating].map(() => false))); }
  return { inspect, prepare, cancel, clear, release: forget, discardGenerated,
    reserveGenerated, abandonGenerated,
    registerOriginal(path) { if (!localPath(path)) throw failure('INVALID_IMAGE', '请选择本地截图。'); originals.add(path); },
    registerEdited(path, previousPath, reservation) { return own(path, [previousPath], reservation); },
    dispose() { disposed = true; return clear(); } };
}
module.exports = { SOURCE_LIMITS, planTiles, sourceMetadata, localPath, createImageProcessor };
