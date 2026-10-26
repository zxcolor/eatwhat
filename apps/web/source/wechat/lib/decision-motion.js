// Native Mini Program motion: no renderer dependency, network or business state.
const TIMING = Object.freeze({ frame: 16, press: 140, state: 240, card: 320, sheet: 320, close: 200, shrink: 220, check: 180, reduced: 100 });
const EASE = Object.freeze({ out: 'cubic-bezier(.23,1,.32,1)', drawer: 'cubic-bezier(.32,.72,0,1)', change: 'cubic-bezier(.77,0,.175,1)' });

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function touch(event, ending = false) {
  const list = ending ? event?.changedTouches : event?.touches;
  if (!Array.isArray(list) || list.length !== 1) return null;
  const point = list[0];
  const x = finite(point.clientX) ? point.clientX : point.pageX;
  const y = finite(point.clientY) ? point.clientY : point.pageY;
  return finite(x) && finite(y) ? { x, y, id: point.identifier, time: finite(event.timeStamp) ? event.timeStamp : Date.now() } : null;
}
function gestureAxis(dx, dy) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return '';
  return Math.abs(dx) > Math.abs(dy) * 1.25 ? 'x' : 'y';
}
function swipeDecision({ x, velocity, width }) {
  const distance = Math.max(64, Math.min(120, width * .24));
  const commits = Math.abs(x) >= distance || (Math.abs(x) >= 24 && Math.abs(velocity) >= .55 && Math.sign(x) === Math.sign(velocity));
  return { commits, direction: x < 0 ? -1 : 1 };
}
function revealGeometry(origin, bounds) {
  if (!origin || !finite(origin.x) || !finite(origin.y) || !bounds || !finite(bounds.width) || !finite(bounds.height)) return null;
  const x = origin.x - (bounds.left || 0), y = origin.y - (bounds.top || 0);
  const radius = Math.ceil(Math.max(Math.hypot(x, y), Math.hypot(bounds.width - x, y), Math.hypot(x, bounds.height - y), Math.hypot(bounds.width - x, bounds.height - y))) + 2;
  return { x, y, radius };
}
function sourceTransform(source, target) {
  if (!source || !target || ![source.left, source.top, source.width, source.height, target.left, target.top, target.width, target.height].every(finite)
    || source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) return null;
  return { x: source.left + source.width / 2 - target.left - target.width / 2, y: source.top + source.height / 2 - target.top - target.height / 2,
    scaleX: Math.max(.1, Math.min(1, source.width / target.width)), scaleY: Math.max(.1, Math.min(1, source.height / target.height)) };
}
function cardTransform(x, width, reduced = false) {
  if (reduced) return 'transform:translate3d(0,0,0);';
  const rotation = Math.max(-7, Math.min(7, x / Math.max(1, width) * 7));
  return `transform:translate3d(${Math.round(x * 100) / 100}px,0,0) rotate(${rotation.toFixed(2)}deg);`;
}
function springStep({ x, velocity }, elapsedSeconds, config = { duration: .5, bounce: .2 }) {
  // Damping is derived from the duration/bounce recipe, rather than another
  // arbitrary spring token. Velocity is px/s and survives interrupted settling.
  const decay = -Math.log(.01) / config.duration;
  const logBounce = Math.log(config.bounce);
  const dampingRatio = -logBounce / Math.sqrt(Math.PI * Math.PI + logBounce * logBounce);
  const stiffness = (decay / dampingRatio) ** 2;
  const dt = Math.min(.032, Math.max(.001, elapsedSeconds));
  const nextVelocity = velocity + (-stiffness * x - 2 * decay * velocity) * dt;
  const nextX = x + nextVelocity * dt;
  return { x: nextX, velocity: nextVelocity, settled: Math.abs(nextX) < .35 && Math.abs(nextVelocity) < 3 };
}

module.exports = { TIMING, EASE, touch, gestureAxis, swipeDecision, revealGeometry, sourceTransform, cardTransform, springStep };
