// RAW 解码引擎封装:LibRaw 负责解马赛克/白平衡/色彩矩阵,得到 8 位 sRGB 像素
// 移植自原 app.js 的 decodeFile 逻辑(含 Linear DNG 内嵌全尺寸 JPEG 优先路径)

import { LibRaw, type LibRawMeta } from './libraw'

export interface RawDoc {
  w: number
  h: number
  src: Uint8Array          // RGBA8 全分辨率像素
  meta?: LibRawMeta
  raw?: LibRaw | null
  name: string
  size: number
  engine: string
  linearDng?: boolean
  embedded?: { off: number; len: number; w: number; h: number }
}

// 三档质量(对应 dcraw 参数 userQual / halfSize)
export const ENGINES: Record<string, { label: string; userQual: number; halfSize: boolean }> = {
  1: { label: '标准', userQual: 3, halfSize: false },
  2: { label: '高质量', userQual: 6, halfSize: false },
  3: { label: '快速', userQual: 2, halfSize: true },
}

// Linear DNG 检测:Lightroom 等导出的线性 DNG 缺 Bayer 阵列,LibRaw 输出灰白/褪色/偏绿
export function isLinearDng(m: LibRawMeta | null): boolean {
  if (!m) return false
  if ((m.camera_make || '').trim() === 'TIFF') return true
  const cd = m.color_data
  if (cd && cd.filters === 0 && (cd.colors ?? 0) >= 3 && /RGB/.test(m.cdesc || '')) return true
  return false
}

// 解析 TIFF/IFD 链(IFD0 + SubIFDs),找出尺寸最大的内嵌 JPEG 预览
export function extractEmbeddedJpeg(buf: ArrayBuffer): { off: number; len: number; w: number; h: number } | null {
  const dv = new DataView(buf)
  if (dv.byteLength < 16) return null
  const b0 = dv.getUint16(0)
  if (b0 !== 0x4949 && b0 !== 0x4d4d) return null
  const le = b0 === 0x4949
  const u16 = (o: number) => dv.getUint16(o, le)
  const u32 = (o: number) => dv.getUint32(o, le)
  if (u16(2) !== 42) return null

  let best: { off: number; len: number; w: number; h: number } | null = null

  const firstVal = (voff: number, typ: number, cnt: number) => {
    if (!cnt) return 0
    if (typ === 1) return dv.getUint8(voff)
    if (typ === 3) return dv.getUint16(voff, le)
    if (typ === 4) return dv.getUint32(voff, le)
    return 0
  }

  const visit = (off: number) => {
    if (off <= 0 || off + 2 > dv.byteLength) return
    const n = u16(off)
    if (!n || off + 2 + n * 12 + 4 > dv.byteLength) return
    let w = 0, h = 0, comp = 0, phot = 0
    let so = 0, sbc = 0, jpgo = 0, jpgl = 0
    let subIfds: number[] | null = null
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12
      const tag = u16(e), typ = u16(e + 2), cnt = u32(e + 4)
      const size = typ === 1 ? 1 : typ === 3 ? 2 : typ === 4 ? 4 : typ === 5 ? 8 : 0
      if (!size || !cnt) continue
      let voff = e + 8
      if (size * cnt > 4) voff = u32(e + 8)
      if (voff + size * cnt > dv.byteLength) continue
      switch (tag) {
        case 0x0100: w = firstVal(voff, typ, cnt); break
        case 0x0101: h = firstVal(voff, typ, cnt); break
        case 0x0103: comp = firstVal(voff, typ, cnt); break
        case 0x0106: phot = firstVal(voff, typ, cnt); break
        case 0x0111: so = firstVal(voff, typ, cnt); break
        case 0x0117: sbc = firstVal(voff, typ, cnt); break
        case 0x0201: jpgo = firstVal(voff, typ, cnt); break
        case 0x0202: jpgl = firstVal(voff, typ, cnt); break
        case 0x014a: {
          if (typ === 4) { subIfds = []; for (let k = 0; k < cnt; k++) subIfds.push(u32(voff + k * 4)) }
          else if (typ === 3) { subIfds = []; for (let k = 0; k < cnt; k++) subIfds.push(u16(voff + k * 2)) }
          break
        }
      }
    }
    if ((comp === 6 || comp === 7) && (phot === 2 || phot === 6)) {
      const joff = jpgo || so, jlen = jpgl || sbc
      if (joff > 0 && jlen > 0 && w > 0 && h > 0 &&
          joff + jlen <= dv.byteLength &&
          dv.getUint8(joff) === 0xff && dv.getUint8(joff + 1) === 0xd8 &&
          (!best || w * h > best.w * best.h)) {
        best = { off: joff, len: jlen, w, h }
      }
    }
    if (subIfds) for (const s of subIfds) visit(s)
  }

  visit(u32(4))
  return best
}

// 把内嵌 JPEG 解码为 RGBA8 像素
async function jpegToRgba(buf: ArrayBuffer, off: number, len: number): Promise<{ w: number; h: number; src: Uint8Array }> {
  const blob = new Blob([new Uint8Array(buf.slice(off, off + len))], { type: 'image/jpeg' })
  const bitmap = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bitmap.width; c.height = bitmap.height
  const ctx = c.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const id = ctx.getImageData(0, 0, c.width, c.height)
  return {
    w: c.width, h: c.height,
    src: new Uint8Array(id.data.buffer.slice(id.data.byteOffset, id.data.byteOffset + id.data.byteLength)),
  }
}

// 解码单个文件为 RawDoc
export async function decodeFile(
  file: File,
  engineKey: string,
  extraParams: Record<string, unknown> = {},
  onStatus?: (msg: string, sub?: string) => void,
): Promise<RawDoc> {
  const eng = ENGINES[engineKey]
  const buf = await file.arrayBuffer()
  onStatus?.('正在解析 RAW 文件…', file.name)

  // Linear DNG:直接用内嵌全尺寸 JPEG 作为显示来源
  if (!extraParams.forceLibRaw) {
    const probe = new LibRaw()
    let mProbe: LibRawMeta | null = null
    try {
      await probe.open(new Uint8Array(buf.slice(0)), {})
      mProbe = await probe.metadata(true)
    } catch { /* ignore */ }
    try { probe.dispose() } catch { /* ignore */ }
    if (isLinearDng(mProbe)) {
      const jpeg = extractEmbeddedJpeg(buf)
      if (jpeg) {
        onStatus?.('检测到 Linear DNG,使用内嵌全尺寸 JPEG…', file.name + ' 尺寸 ' + jpeg.w + '×' + jpeg.h)
        const px = await jpegToRgba(buf, jpeg.off, jpeg.len)
        const doc: RawDoc = {
          w: px.w, h: px.h, src: px.src, name: file.name, size: file.size,
          engine: engineKey, linearDng: true, embedded: jpeg,
        }
        doc.meta = {
          camera_make: 'Linear DNG',
          camera_model: 'Lightroom',
          software: mProbe?.software,
          width: px.w, height: px.h,
          desc: '线性 DNG(已去马赛克),使用内嵌全尺寸 JPEG 显示。原始 Bayer 数据不在此类文件中。',
        }
        return doc
      }
    }
  }

  const bytes = new Uint8Array(buf.slice(0))
  const r = new LibRaw()
  try {
    await r.open(bytes, Object.assign({
      outputBps: 8,
      outputColor: 1,
      userQual: eng.userQual,
      halfSize: eng.halfSize,
      useCameraMatrix: 1,
      outputTiff: false,
      userFlip: -1,
      useCameraWb: true,
      noAutoBright: false,
      autoBrightThr: 0.01,
    }, extraParams))
    onStatus?.('正在解码…', file.name)
    const m = await r.metadata(true)
    const img = await r.imageData()
    if (!img || !img.width || !img.height || !img.data) throw new Error('LibRaw 未能生成图像')

    const w = img.width, h = img.height
    const srcD = img.data
    const src = new Uint8Array(w * h * 4)
    if (srcD.length >= w * h * 3) {
      for (let i = 0, p = 0; i < w * h * 3; i += 3, p += 4) {
        src[p] = srcD[i]; src[p + 1] = srcD[i + 1]; src[p + 2] = srcD[i + 2]; src[p + 3] = 255
      }
    } else {
      throw new Error('LibRaw 返回的图像数据格式不符')
    }
    return { raw: r, meta: m, w, h, src, name: file.name, size: file.size, engine: engineKey }
  } catch (e) {
    try { r.dispose() } catch { /* ignore */ }
    throw e
  }
}
