// 渲染管线:src(RGBA8 原解码) -> 显示(曝光/亮度/对比度/饱和度/高光阴影/白平衡增益)
// 移植自原 app.js 的 renderFrame / LUT 逻辑

import type { RawDoc } from './rawEngine'

export interface AdjustOpts {
  ev: number
  br: number
  ct: number
  sat: number
  hi: number
  sh: number
}

export const ADJUST_PRESET: AdjustOpts = { ev: 0, br: 1, ct: 0, sat: 100, hi: 0, sh: 0 }

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

// 深度渲染:doc.src(整分辨率 8 位) -> out(Uint8Array)
// extraGains 可选:批量导出时传入导出的通道增益
const EXP_LUT = new Float32Array(4097)
const TONE_LUT = new Float32Array(256)
const CONTRAST_LUT = new Float32Array(256)
let lutState: Record<string, number> = { ev: NaN, br: NaN, hi: NaN, sh: NaN, ct: NaN }

function rebuildLuts(opts: AdjustOpts) {
  const { ev, br, hi, sh, ct } = opts
  const hiAmt = hi / 100, shAmt = sh / 100
  const gain = Math.pow(2, ev) * br
  if (ev !== lutState.ev || br !== lutState.br) {
    for (let i = 0; i < 4097; i++) {
      let v = (i / 4096 * 255) * gain
      v = clamp(v, 0, 255)
      EXP_LUT[i] = v
    }
  }
  if (hi !== lutState.hi || sh !== lutState.sh) {
    for (let i = 0; i < 256; i++) {
      let t = i / 255
      t = clamp(t + shAmt * (1 - t) * (0.35 + 0.65 * (1 - t)), 0, 1)
      t = clamp(t - hiAmt * t * (0.35 + 0.65 * t), 0, 1)
      TONE_LUT[i] = t * 255
    }
  }
  if (ct !== lutState.ct) {
    const c = ct / 100
    for (let i = 0; i < 256; i++) {
      const t = i / 255
      let o = c === 0 ? t : 0.5 + Math.sign(t - 0.5) * Math.pow(Math.abs(t - 0.5) * 2, 1 / (1 + c * 0.85)) * 0.5
      CONTRAST_LUT[i] = clamp(o, 0, 1) * 255
    }
  }
  lutState = { ev, br, hi, sh, ct }
}

export function renderFrame(
  doc: Pick<RawDoc, 'w' | 'h' | 'src'>,
  opts: AdjustOpts,
  out: Uint8Array,
  extraGains?: { r: number; g: number; b: number },
) {
  const { w, h, src } = doc
  rebuildLuts(opts)
  const satF = opts.sat / 100
  const g = extraGains || { r: 1, g: 1, b: 1 }
  const rg = g.r, gg = g.g, bg = g.b
  const useGain = rg !== 1 || gg !== 1 || bg !== 1
  const E = EXP_LUT, T = TONE_LUT, C = CONTRAST_LUT
  const n = w * h
  let p = 0, q = 0
  for (let i = 0; i < n; i++) {
    let r = src[p], gv = src[p + 1], b = src[p + 2]
    p += 4
    r = E[(r / 255 * 4096) | 0]
    gv = E[(gv / 255 * 4096) | 0]
    b = E[(b / 255 * 4096) | 0]
    r = r | 0; gv = gv | 0; b = b | 0
    r = T[r | 0]; gv = T[gv | 0]; b = T[b | 0]
    r = C[r | 0]; gv = C[gv | 0]; b = C[b | 0]
    if (satF !== 1) {
      const lum = 0.299 * r + 0.587 * gv + 0.114 * b
      r = lum + (r - lum) * satF
      gv = lum + (gv - lum) * satF
      b = lum + (b - lum) * satF
    }
    if (useGain) { r *= rg; gv *= gg; b *= bg }
    out[q++] = r > 255 ? 255 : r
    out[q++] = gv > 255 ? 255 : gv
    out[q++] = b > 255 ? 255 : b
    out[q++] = 255
  }
}

// 直方图
export interface Hist {
  hr: Float32Array; hg: Float32Array; hb: Float32Array; hl: Float32Array
  step: number
}

export function computeHist(rgba: Uint8Array, w: number, h: number): Hist {
  const hr = new Float32Array(256), hg = new Float32Array(256), hb = new Float32Array(256), hl = new Float32Array(256)
  const step = Math.max(1, Math.floor((w * h) / 600000))
  for (let i = 0; i < w * h; i += step) {
    const p = i * 4
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2]
    hr[r]++; hg[g]++; hb[b]++
    hl[(r * 299 + g * 587 + b * 114) / 1000 | 0]++
  }
  return { hr, hg, hb, hl, step }
}

export function maxOf(a: Float32Array) {
  let m = 0
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]
  return m
}

// 缩略图:从已解码的全分辨率像素生成,contain 语义整张照片缩入 392×264 框
export function makeThumbDataUrl(doc: Pick<RawDoc, 'w' | 'h' | 'src'>): string {
  try {
    const { w, h, src } = doc
    const cw = 392, ch = 264
    const scale = Math.min(cw / w, ch / h)
    const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale))
    const c = document.createElement('canvas')
    c.width = cw; c.height = ch
    const ctx = c.getContext('2d')!
    const rgba = new Uint8ClampedArray(src.buffer, 0, w * h * 4)
    const img = new ImageData(new Uint8ClampedArray(rgba), w, h)
    const tmp = document.createElement('canvas')
    tmp.width = w; tmp.height = h
    tmp.getContext('2d')!.putImageData(img, 0, 0)
    const d = img.data
    const avg = (i: number) => Math.round((d[i] + d[i + 4] + d[i + 8] + d[i + 12]) / 4)
    ctx.fillStyle = `rgb(${avg(0)},${avg(1)},${avg(2)})`
    ctx.fillRect(0, 0, cw, ch)
    const ox = Math.round((cw - dw) / 2), oy = Math.round((ch - dh) / 2)
    ctx.drawImage(tmp, ox, oy, dw, dh)
    const grad = ctx.createLinearGradient(0, ch * 0.72, 0, ch)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,.55)')
    ctx.fillStyle = grad
    ctx.fillRect(0, ch * 0.72, cw, ch * 0.28)
    return c.toDataURL('image/jpeg', 0.82)
  } catch {
    return ''
  }
}

// 渲染到画布:返回 renderCanvas(整分辨率离屏)
export function renderToCanvas(doc: Pick<RawDoc, 'w' | 'h' | 'src'>, opts: AdjustOpts, extraGains?: { r: number; g: number; b: number }) {
  const c = document.createElement('canvas')
  c.width = doc.w; c.height = doc.h
  const ctx = c.getContext('2d')!
  const out = new Uint8Array(doc.w * doc.h * 4)
  renderFrame(doc, opts, out, extraGains)
  ctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer, 0, out.length), doc.w, doc.h), 0, 0)
  return c
}
