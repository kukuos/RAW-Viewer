// 工具函数:文件大小格式化、时间戳、JPEG/ZIP 导出
// 移植自原 app.js 的 exportCurrent / exportAllZip / buildZip 逻辑

export function fmtBytes(n: number) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}

export function fmtShutter(s: number) {
  if (s >= 1) return s >= 60 ? Math.round(s) + ' s' : s.toFixed(1) + ' s'
  return '1/' + Math.round(1 / s)
}

export function timestamp() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return String(d.getFullYear()).slice(-2) + p(d.getMonth() + 1) + p(d.getDate()) +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

export function canvasToJpegBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.92))
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// 把所有 JPEG 打包为一个 ZIP 压缩包(store,UTF-8 文件名,ZIP64 支持)
export async function buildZip(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      t[n] = c >>> 0
    }
    return t
  })()
  const crc32 = (buf: Uint8Array, start: number, len: number) => {
    let c = 0xffffffff
    for (let i = start; i < start + len; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const u16 = (arr: Uint8Array, o: number, v: number) => { arr[o] = v & 255; arr[o + 1] = (v >>> 8) & 255 }
  const u32 = (arr: Uint8Array, o: number, v: number) => {
    arr[o] = v & 255; arr[o + 1] = (v >>> 8) & 255; arr[o + 2] = (v >>> 16) & 255; arr[o + 3] = (v >>> 24) & 255
  }
  const d = new Date(1990, 0, 1)
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)

  function safeName(n: string) {
    let s = String(n).replace(/\\/g, '/').replace(/^.*\//, '')
    if (!s || s.startsWith('.')) s = '_' + s
    return s
  }

  const parts: (BlobPart)[] = []
  let offset = 0
  const central: Uint8Array[] = []
  let totalSize = 0
  for (const f of files) {
    const name = encoder.encode(safeName(f.name))
    const data = new Uint8Array(await f.blob.arrayBuffer())
    const crc = crc32(data, 0, data.length)
    totalSize += data.length
    // BlobPart 需要 ArrayBuffer 视图带 ArrayBuffer backing;这里显式转一次
    const dataCopy = new Uint8Array(data.byteLength)
    dataCopy.set(data)

    const lh = new Uint8Array(30 + name.length)
    u32(lh, 0, 0x04034b50)
    u16(lh, 4, 20)
    u16(lh, 6, 0x0800)
    u16(lh, 8, 0)
    u16(lh, 10, dosTime)
    u16(lh, 12, dosDate)
    u32(lh, 14, crc)
    u32(lh, 18, data.length)
    u32(lh, 22, data.length)
    u16(lh, 26, name.length)
    u16(lh, 28, 0)
    lh.set(name, 30)
    parts.push(lh, dataCopy)

    const ch = new Uint8Array(46 + name.length)
    u32(ch, 0, 0x02014b50)
    u16(ch, 4, 20); u16(ch, 6, 20)
    u16(ch, 8, 0x0800)
    u16(ch, 10, 0)
    u16(ch, 12, dosTime)
    u16(ch, 14, dosDate)
    u32(ch, 16, crc)
    u32(ch, 20, data.length)
    u32(ch, 24, data.length)
    u16(ch, 28, name.length)
    u16(ch, 30, 0)
    u16(ch, 32, 0)
    u16(ch, 34, 0)
    u16(ch, 36, 0)
    u32(ch, 38, 0)
    u32(ch, 42, offset)
    ch.set(name, 46)
    central.push(ch)
    offset += 30 + name.length + data.length
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const needZip64 = central.length > 0xffff || offset > 0xffffffff

  const eocd = new Uint8Array(22)
  u32(eocd, 0, 0x06054b50)
  u16(eocd, 4, 0)
  u16(eocd, 6, 0)
  u16(eocd, 8, central.length)
  u16(eocd, 10, central.length)
  u32(eocd, 12, centralSize)
  u32(eocd, 16, offset)
  if (needZip64) {
    u16(eocd, 8, 0xffff); u16(eocd, 10, 0xffff)
    u32(eocd, 12, 0xffffffff); u32(eocd, 16, 0xffffffff)
  }
  for (const c of central) {
    const cc = new Uint8Array(c.byteLength)
    cc.set(c)
    parts.push(cc)
  }
  if (needZip64) {
    const z64 = new Uint8Array(56)
    u32(z64, 0, 0x06064b50)
    u32(z64, 4, 44)
    u32(z64, 8, 45)
    u32(z64, 12, 45)
    u32(z64, 16, 0)
    u32(z64, 20, 0)
    u32(z64, 24, central.length)
    u32(z64, 28, central.length)
    u32(z64, 32, centralSize)
    u32(z64, 40, offset)
    u32(z64, 48, 1)
    parts.push(z64)
    const loc = new Uint8Array(20)
    u32(loc, 0, 0x07064b50)
    u32(loc, 4, 0)
    u32(loc, 8, offset + centralSize)
    u32(loc, 12, 1)
    parts.push(loc)
  }
  parts.push(eocd)
  return new Blob(parts, { type: 'application/zip' })
}

// 元数据转键值列表(展示用)
export function fmtExif(m: Record<string, unknown> | undefined): [string, string][] {
  if (!m) return []
  const out: [string, string][] = []
  const push = (k: string, v: unknown) => {
    if (v === null || v === undefined) return
    if (typeof v === 'string') out.push([k, v])
    else out.push([k, String(v)])
  }
  push('相机型号', [m.camera_make, m.camera_model].filter(Boolean).join(' ') || '未知')
  const lens = m.lens as Record<string, string> | undefined
  if (lens && lens['Lens']) push('镜头', lens['Lens'])
  push('ISO', m.iso_speed)
  push('焦距', m.focal_len != null && Number(m.focal_len) > 0 ? Number(m.focal_len).toFixed(1) + ' mm' : null)
  push('快门', typeof m.shutter === 'number' ? fmtShutter(m.shutter) : null)
  push('光圈', typeof m.aperture === 'number' ? 'f/' + m.aperture.toFixed(1) : null)
  if (m.flip != null && m.flip !== undefined) {
    const flipMap: Record<number, string> = { 0: '正常', 3: '旋转180°', 5: '右转90°', 6: '左转90°' }
    push('方向', flipMap[Number(m.flip)] || ('翻转 ' + m.flip))
  }
  if (m.timestamp instanceof Date && !isNaN(+m.timestamp)) push('拍摄时间', m.timestamp.toLocaleString('zh-CN', { hour12: false }))
  push('尺寸', (m.width || '') + ' × ' + (m.height || '') + ' px')
  push('RAW 张数', m.raw_count)
  push('DNG 版本', m.dng_version)
  push('传感器', m.is_foveon ? 'Foveon' : null)
  push('软件', m.software)
  push('作者', m.artist)
  push('描述', m.desc)
  const cd = m.color_data as Record<string, unknown> | undefined
  if (cd) {
    push('传感器黑电平', cd.black)
    push('原始深度', (cd.raw_bps || 14) + ' bit')
    if (Array.isArray(cd.cam_mul) && cd.cam_mul.length) push('相机白平衡', cd.cam_mul.map(x => Number(x).toFixed(2)).join(' / '))
    push('饱和度上限', cd.maximum)
  }
  const mc = m.metadata_common as Record<string, unknown> | undefined
  if (mc) {
    if (typeof mc.SensorTemperature === 'number') push('传感器温度', mc.SensorTemperature.toFixed(1) + ' °C')
    if (typeof mc.CameraTemperature === 'number') push('机身温度', mc.CameraTemperature.toFixed(1) + ' °C')
  }
  return out
}
