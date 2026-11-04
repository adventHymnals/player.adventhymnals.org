// numpy's default_rng(seed) (SeedSequence -> PCG64) with .normal() and .uniform(), bit for bit,
// so the live singer's pitch wander is the renderer's own. Only small integer seeds are needed.
import { KI, WI, FI, NOR_R, NOR_INV_R } from "./ziggurat.js";

const M64 = (1n << 64n) - 1n;
const M128 = (1n << 128n) - 1n;
const MULT = 0x2360ed051fc65da44385df649fccf645n;

function hashmix(value, hc) { // SeedSequence hashmix; hc = [hash_const]
  value = (value ^ hc[0]) >>> 0;
  hc[0] = Math.imul(hc[0], 0x931e8875) >>> 0;
  value = Math.imul(value, hc[0]) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}
function mix(x, y) {
  let r = (Math.imul(0xca01f9dd, x) - Math.imul(0x4973f715, y)) >>> 0;
  return (r ^ (r >>> 16)) >>> 0;
}

/** SeedSequence(seed).generate_state(4, uint64) as BigInts. */
function seedState(seed) {
  const entropy = [];
  let s = seed;
  do { entropy.push(s % 2 ** 32 >>> 0); s = Math.floor(s / 2 ** 32); } while (s > 0);
  const pool = [0, 0, 0, 0];
  const hc = [0x43b0d7e5];
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < entropy.length ? entropy[i] : 0, hc);
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (a !== b) pool[b] = mix(pool[b], hashmix(pool[a], hc));
  for (let a = 4; a < entropy.length; a++) for (let b = 0; b < 4; b++) pool[b] = mix(pool[b], hashmix(entropy[a], hc));
  let h = 0x8b51f9dd;
  const words = [];
  for (let i = 0; i < 8; i++) {
    let v = (pool[i % 4] ^ h) >>> 0;
    h = Math.imul(h, 0x58f38ded) >>> 0;
    v = Math.imul(v, h) >>> 0;
    words.push((v ^ (v >>> 16)) >>> 0);
  }
  return [0, 1, 2, 3].map((k) => (BigInt(words[2 * k + 1]) << 32n) | BigInt(words[2 * k]));
}

export class Rng {
  constructor(seed) {
    const v = seedState(seed);
    const initstate = (v[0] << 64n) | v[1];
    this.inc = ((((v[2] << 64n) | v[3]) << 1n) | 1n) & M128;
    this.state = 0n;
    this.step();
    this.state = (this.state + initstate) & M128;
    this.step();
  }
  step() { this.state = (this.state * MULT + this.inc) & M128; }
  next64() { // XSL-RR
    this.step();
    const s = this.state;
    const x = ((s >> 64n) ^ s) & M64;
    const rot = Number(s >> 122n);
    return ((x >> BigInt(rot)) | (x << BigInt((64 - rot) & 63))) & M64;
  }
  nextDouble() { return Number(this.next64() >> 11n) * (1.0 / 9007199254740992.0); }
  standardNormal() {
    for (;;) {
      let r = this.next64();
      const idx = Number(r & 0xffn);
      r >>= 8n;
      const sign = Number(r & 1n);
      const rabsB = (r >> 1n) & 0x000fffffffffffffn;
      const rabs = Number(rabsB);
      let x = rabs * WI[idx];
      if (sign) x = -x;
      if (rabs < KI[idx]) return x;
      if (idx === 0) {
        for (;;) {
          const xx = -NOR_INV_R * Math.log1p(-this.nextDouble());
          const yy = -Math.log1p(-this.nextDouble());
          if (yy + yy > xx * xx) return Number((rabsB >> 8n) & 1n) ? -(NOR_R + xx) : NOR_R + xx;
        }
      } else if ((FI[idx - 1] - FI[idx]) * this.nextDouble() + FI[idx] < Math.exp(-0.5 * x * x)) return x;
    }
  }
  normal(loc, scale) { return loc + scale * this.standardNormal(); }
  uniform(low, high) { return low + (high - low) * this.nextDouble(); }
}
