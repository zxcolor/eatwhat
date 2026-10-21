// biome-ignore lint/suspicious/noRedundantUseStrict: WeChat loads this as CommonJS, not an ES module.
'use strict';

/** Exact immutable rational arithmetic without native BigInt syntax.
 * Fraction.from(number) preserves the actual IEEE-754 binary64 value.
 * Fraction.from(['numerator', 'denominator']) accepts canonical integer strings;
 * denominator must be positive. Wire results are reduced string pairs.
 * The 65536-digit input-size guard permits round-tripping legal 32-term R3
 * derived scores (whose denominator bound is below 20874 decimal digits).
 * It limits input work; arithmetic is never rounded or truncated to this size.
 * toNumber is an explicitly lossy, correctly rounded binary64 presentation.
 */
const JSBI = require('./vendor/jsbi');
const ZERO = JSBI.BigInt(0);
const ONE = JSBI.BigInt(1);
const TWO = JSBI.BigInt(2);
const MAX_INTEGER_DIGITS = 65536;

function abs(value) { return JSBI.lessThan(value, ZERO) ? JSBI.unaryMinus(value) : value; }
function gcd(left, right) {
  let a = abs(left);
  let b = abs(right);
  while (!JSBI.equal(b, ZERO)) {
    const remainder = JSBI.remainder(a, b);
    a = b;
    b = remainder;
  }
  return a;
}
function shift(value, count) { return JSBI.leftShift(value, JSBI.BigInt(count)); }
function integer(text, positive) {
  if (typeof text !== 'string' || text.length > MAX_INTEGER_DIGITS + 1 || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(text)) {
    throw new TypeError('Fraction integers must be canonical strings of at most 65536 digits');
  }
  if (text.replace('-', '').length > MAX_INTEGER_DIGITS) throw new RangeError('Fraction integer is too long');
  const value = JSBI.BigInt(text);
  if (positive && !JSBI.greaterThan(value, ZERO)) throw new RangeError('Fraction denominator must be positive');
  return value;
}
function roundedQuotient(numerator, denominator) {
  let quotient = JSBI.divide(numerator, denominator);
  const doubledRemainder = JSBI.multiply(JSBI.remainder(numerator, denominator), TWO);
  if (JSBI.greaterThan(doubledRemainder, denominator) ||
      (JSBI.equal(doubledRemainder, denominator) && !JSBI.equal(JSBI.remainder(quotient, TWO), ZERO))) {
    quotient = JSBI.add(quotient, ONE);
  }
  return quotient;
}

class Fraction {
  constructor(numerator, denominator) {
    if (!(numerator instanceof JSBI) || !(denominator instanceof JSBI)) {
      throw new TypeError('Use Fraction.from to construct a fraction');
    }
    if (JSBI.equal(denominator, ZERO)) throw new RangeError('Division by zero');
    let n = numerator;
    let d = denominator;
    if (JSBI.lessThan(d, ZERO)) { n = JSBI.unaryMinus(n); d = JSBI.unaryMinus(d); }
    const common = gcd(n, d);
    Object.defineProperties(this, {
      _n: { value: Object.freeze(JSBI.divide(n, common)) },
      _d: { value: Object.freeze(JSBI.divide(d, common)) },
    });
    Object.freeze(this);
  }
  static from(value) {
    if (value instanceof Fraction) return value;
    if (Array.isArray(value) && value.length === 2) return new Fraction(integer(value[0]), integer(value[1], true));
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected finite number or rational string pair');
    if (value === 0) return new Fraction(ZERO, ONE);
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setFloat64(0, value, false);
    const high = bytes.getUint32(0, false);
    const low = bytes.getUint32(4, false);
    const exponent = (high >>> 20) & 0x7ff;
    const mantissa = (high & 0xfffff) * 0x100000000 + low + (exponent ? 0x10000000000000 : 0);
    const power = exponent ? exponent - 1023 - 52 : -1074;
    let n = JSBI.BigInt(mantissa);
    let d = ONE;
    if (power >= 0) n = shift(n, power); else d = shift(d, -power);
    if (high >>> 31) n = JSBI.unaryMinus(n);
    return new Fraction(n, d);
  }
  add(value) {
    const other = Fraction.from(value);
    const common = gcd(this._d, other._d);
    const leftScale = JSBI.divide(other._d, common);
    const rightScale = JSBI.divide(this._d, common);
    return new Fraction(JSBI.add(JSBI.multiply(this._n, leftScale), JSBI.multiply(other._n, rightScale)), JSBI.multiply(this._d, leftScale));
  }
  sub(value) { return this.add(Fraction.from(value).neg()); }
  mul(value) {
    const other = Fraction.from(value);
    const left = gcd(this._n, other._d);
    const right = gcd(other._n, this._d);
    return new Fraction(JSBI.multiply(JSBI.divide(this._n, left), JSBI.divide(other._n, right)),
      JSBI.multiply(JSBI.divide(this._d, right), JSBI.divide(other._d, left)));
  }
  div(value) {
    const other = Fraction.from(value);
    if (JSBI.equal(other._n, ZERO)) throw new RangeError('Division by zero');
    return this.mul(new Fraction(other._d, other._n));
  }
  cmp(value) {
    const other = Fraction.from(value);
    const left = JSBI.multiply(this._n, other._d);
    const right = JSBI.multiply(other._n, this._d);
    return JSBI.lessThan(left, right) ? -1 : JSBI.greaterThan(left, right) ? 1 : 0;
  }
  neg() { return new Fraction(JSBI.unaryMinus(this._n), this._d); }
  toPair() { return [this._n.toString(), this._d.toString()]; }
  toJSON() { return this.toPair(); }
  toNumber() {
    if (JSBI.equal(this._n, ZERO)) return 0;
    const sign = JSBI.lessThan(this._n, ZERO) ? -1 : 1;
    const n = abs(this._n);
    const d = this._d;
    let exponent = n.toString(2).length - d.toString(2).length;
    if (exponent >= 0 ? JSBI.lessThan(n, shift(d, exponent)) : JSBI.lessThan(shift(n, -exponent), d)) exponent -= 1;
    if (exponent > 1023) return sign * Infinity;
    if (exponent < -1075) return sign * 0;
    const power = exponent < -1022 ? 1074 : 52 - exponent;
    const q = power >= 0 ? roundedQuotient(shift(n, power), d) : roundedQuotient(n, shift(d, -power));
    return sign * JSBI.toNumber(q) * 2 ** -power;
  }
}

module.exports = { Fraction };
