(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const element = (name, attributes = {}, text) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text) node.textContent = text;
    return node;
  };
  const valid = point => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;
  window.EWRenderMap = (host, props) => {
    if (!host.__routeView) {
      const svg = element('svg', { viewBox: '0 0 640 400', role: 'img', 'aria-label': '实际道路路线示意图，不含地图底图', tabindex: '0' });
      const geometry = element('g');
      svg.append(element('rect', { width: 640, height: 400, fill: 'var(--route-map-bg, #e8eff2)' }), geometry);
      const controls = document.createElement('div'); controls.className = 'web-map-controls';
      const state = { svg, geometry, zoom: 1, x: 0, y: 0, signature: '' };
      const transform = () => geometry.setAttribute('transform', `translate(${320 + state.x} ${200 + state.y}) scale(${state.zoom}) translate(-320 -200)`);
      for (const [label, text, action] of [['放大路线', '+', () => { state.zoom = Math.min(8, state.zoom * 1.4); }], ['缩小路线', '−', () => { state.zoom = Math.max(.7, state.zoom / 1.4); }], ['复位路线', '全程', () => { state.zoom = 1; state.x = state.y = 0; }]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', label);
        button.addEventListener('click', event => { event.stopPropagation(); action(); transform(); }); controls.append(button);
      }
      const caption = document.createElement('div'); caption.className = 'web-map-caption'; caption.textContent = '路线示意 · 无地图底图';
      const compass = document.createElement('div'); compass.className = 'web-map-compass'; compass.textContent = '↑ 北'; compass.setAttribute('aria-hidden', 'true');
      svg.addEventListener('pointerdown', event => { state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; svg.setPointerCapture(event.pointerId); });
      svg.addEventListener('pointermove', event => {
        if (state.pointer?.id !== event.pointerId) return;
        const ratio = 640 / svg.getBoundingClientRect().width;
        state.x += (event.clientX - state.pointer.x) * ratio; state.y += (event.clientY - state.pointer.y) * ratio;
        state.pointer.x = event.clientX; state.pointer.y = event.clientY; transform();
      });
      const end = () => { state.pointer = null; }; svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
      svg.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', 'Home'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'ArrowUp') state.y += 20;
        if (event.key === 'ArrowDown') state.y -= 20;
        if (event.key === 'ArrowLeft') state.x += 20;
        if (event.key === 'ArrowRight') state.x -= 20;
        if (event.key === '+') state.zoom = Math.min(8, state.zoom * 1.4);
        if (event.key === '-') state.zoom = Math.max(.7, state.zoom / 1.4);
        if (event.key === 'Home') { state.zoom = 1; state.x = state.y = 0; }
        transform();
      });
      host.append(svg, compass, caption, controls); host.__routeView = state;
    }
    const state = host.__routeView;
    const lines = (Array.isArray(props.polyline) ? props.polyline : []).filter(line => Array.isArray(line.points));
    const markers = (Array.isArray(props.markers) ? props.markers : []).filter(valid);
    const bounds = (Array.isArray(props['include-points']) ? props['include-points'] : []).filter(valid);
    const all = bounds.length > 1 ? bounds : [...lines.flatMap(line => line.points.filter(valid)), ...markers];
    const signature = JSON.stringify([lines, markers, bounds]);
    if (state.signature === signature) return;
    state.signature = signature;
    state.geometry.replaceChildren(); state.zoom = 1; state.x = state.y = 0; state.geometry.removeAttribute('transform');
    if (!all.length) return;
    const meanLatitude = all.reduce((sum, point) => sum + point.latitude, 0) / all.length;
    const cosine = Math.cos(meanLatitude * Math.PI / 180);
    const xs = all.map(point => point.longitude * cosine), ys = all.map(point => -point.latitude);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    const scale = Math.min(520 / Math.max(right - left, .0001), 280 / Math.max(bottom - top, .0001));
    const project = point => [320 + (point.longitude * cosine - (left + right) / 2) * scale, 200 + (-point.latitude - (top + bottom) / 2) * scale];
    for (const line of lines) {
      const points = line.points.filter(valid).map(project).map(point => point.join(',')).join(' ');
      if (!points) continue;
      state.geometry.append(element('polyline', { points, fill: 'none', stroke: '#fff', 'stroke-width': Number(line.width || 5) + 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      state.geometry.append(element('polyline', { points, fill: 'none', stroke: /^#[0-9a-f]{6,8}$/i.test(line.color) ? line.color : '#246fe8', 'stroke-width': Number(line.width || 5), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    for (const marker of markers) {
      const [cx, cy] = project(marker); const color = marker.id === 1 ? '#328269' : '#b94a29';
      state.geometry.append(element('circle', { cx, cy, r: 9, fill: color, stroke: '#fff', 'stroke-width': 3 }));
      state.geometry.append(element('text', { x: cx, y: cy - 18, 'text-anchor': 'middle', fill: 'var(--route-map-ink, #172b3c)', 'font-size': 18, 'font-weight': 600, 'paint-order': 'stroke', stroke: 'var(--route-map-bg, #e8eff2)', 'stroke-width': 5 }, marker.callout?.content || '位置'));
    }
    const metersPerUnit = 111320 / scale;
    const distance = [20, 50, 100, 200, 500, 1000, 2000, 5000].find(value => value / metersPerUnit >= 50) || 10000;
    const width = Math.min(160, distance / metersPerUnit);
    state.geometry.append(element('path', { d: `M35 340v8h${width}v-8`, fill: 'none', stroke: 'var(--route-map-ink, #172b3c)', 'stroke-width': 2 }));
    state.geometry.append(element('text', { x: 35, y: 332, fill: 'var(--route-map-ink, #172b3c)', 'font-size': 14 }, distance >= 1000 ? `${distance / 1000} km` : `${distance} m`));
  };
})();
