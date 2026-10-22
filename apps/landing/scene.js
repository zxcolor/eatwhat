(() => {
  'use strict';

  const canvas = document.querySelector('#cosmos');
  const context = canvas.getContext('2d', { alpha: true });
  const toggle = document.querySelector('.motion-toggle');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!context) return;

  let width = 0;
  let height = 0;
  let frame = 0;
  let time = 0;
  let previousTime = 0;
  let paused = reducedMotion.matches;
  let pointerX = 0;
  let pointerY = 0;
  let driftX = 0;
  let driftY = 0;
  let seed = 44;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const stars = Array.from({ length: 150 }, () => ({
    x: random(), y: random(), size: random() * 1.2 + .2,
    alpha: random() * .5 + .12, phase: random() * Math.PI * 2,
  }));
  const particles = Array.from({ length: 1900 }, () => ({
    angle: random() * Math.PI * 2,
    radius: 1 + (random() - .5) * .21,
    elevation: (random() - .5) * .048,
    size: random() * 1.3 + .25,
    alpha: random() * .6 + .18,
    speed: .5 + random() * .5,
  }));

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    render();
  }

  function render() {
    context.clearRect(0, 0, width, height);
    const mobile = width <= 700;
    const radius = mobile ? width * .62 : Math.min(width * .385, 660);
    const centerX = width * .5 + driftX;
    const centerY = Math.min(height * .46, mobile ? 330 : height * .5) + driftY;
    for (const star of stars) {
      const twinkle = .78 + Math.sin(time * .35 + star.phase) * .22;
      context.fillStyle = `rgba(174,210,244,${star.alpha * twinkle})`;
      context.beginPath();
      context.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2);
      context.fill();
    }

    context.save();
    context.translate(centerX, centerY);
    context.rotate(-.24);
    context.scale(1, .47);
    const halo = context.createRadialGradient(0, 0, radius * .73, 0, 0, radius * 1.22);
    halo.addColorStop(0, '#0a438900');
    halo.addColorStop(.42, '#2586f12b');
    halo.addColorStop(.55, '#88dfff4a');
    halo.addColorStop(.65, '#1b71dd19');
    halo.addColorStop(1, '#1261b900');
    context.fillStyle = halo;
    context.fillRect(-radius * 1.3, -radius * 1.3, radius * 2.6, radius * 2.6);
    context.lineWidth = .7;
    for (const offset of [.88, .98, 1.025, 1.13]) {
      context.strokeStyle = offset === .98 ? '#b0e6ff65' : '#6eb8ff21';
      context.beginPath();
      context.arc(0, 0, radius * offset, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();

    const tilt = -.24;
    const cosine = Math.cos(tilt);
    const sine = Math.sin(tilt);
    context.globalCompositeOperation = 'lighter';
    for (const particle of particles) {
      const angle = particle.angle + time * .032 * particle.speed;
      const x = Math.cos(angle) * radius * particle.radius;
      const y = Math.sin(angle) * radius * .47 * particle.radius + particle.elevation * radius;
      const screenX = centerX + x * cosine - y * sine;
      const screenY = centerY + x * sine + y * cosine;
      const front = (Math.sin(angle) + 1) * .5;
      const alpha = particle.alpha * (.45 + front * .55);
      context.fillStyle = `rgba(${Math.round(125 + front * 70)},${Math.round(184 + front * 45)},255,${alpha})`;
      const size = particle.size * (mobile ? .7 : 1);
      context.fillRect(screenX, screenY, size * 1.8, size * .7);
    }
    context.globalCompositeOperation = 'source-over';

    // Dim the center so the title remains readable against the particle field.
    const shade = context.createRadialGradient(centerX, centerY, radius * .1, centerX, centerY, radius * .83);
    shade.addColorStop(0, '#030812a3');
    shade.addColorStop(.6, '#03081258');
    shade.addColorStop(1, '#03081200');
    context.fillStyle = shade;
    context.fillRect(0, 0, width, height);
  }

  function animate(timestamp) {
    frame = 0;
    if (paused || document.hidden) return;
    if (timestamp - previousTime >= 1000 / 30) {
      time += Math.min((timestamp - previousTime) / 1000, .05);
      previousTime = timestamp;
      driftX += (pointerX - driftX) * .045;
      driftY += (pointerY - driftY) * .045;
      render();
    }
    frame = window.requestAnimationFrame(animate);
  }

  function syncMotion() {
    window.cancelAnimationFrame(frame);
    frame = 0;
    document.body.classList.toggle('motion-paused', paused);
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? '播放背景动画' : '暂停背景动画');
    if (!paused && !document.hidden) {
      previousTime = performance.now();
      frame = window.requestAnimationFrame(animate);
    }
  }

  toggle.hidden = false;
  toggle.addEventListener('click', () => { paused = !paused; syncMotion(); });
  reducedMotion.addEventListener('change', () => {
    paused = reducedMotion.matches;
    driftX = driftY = pointerX = pointerY = 0;
    syncMotion();
    render();
  });
  document.addEventListener('visibilitychange', syncMotion);
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pointermove', (event) => {
    if (paused || reducedMotion.matches || event.pointerType !== 'mouse') return;
    pointerX = (event.clientX / width - .5) * 16;
    pointerY = (event.clientY / height - .5) * 10;
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointerX = pointerY = 0; });
  resize();
  syncMotion();
})();
