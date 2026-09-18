// RAW 文件查看助手 - 主体逻辑
// 引擎:ybouane/LibRaw-Wasm(LibRaw 编译为 WebAssembly)
// 项目: https://github.com/ybouane/LibRaw-Wasm (Apache-2.0)
// 说明: LibRaw 负责解马赛克/白平衡/色彩矩阵,得到 8 位 sRGB 像素;
//       本文件负责曝光/对比度/饱和度/高光阴影等显示层调整与界面交互。

import LibRaw from './libraw/index.js';

// ===================================================================
// DOM 引用
// ===================================================================
const $ = id => document.getElementById(id);
const btn = id => document.getElementById(id);
const fitView = $('canvas');                 // 适应窗口(恒显示)
const fitCtx = fitView.getContext('2d');
const holder = $('holder');
const iv = $('iv');                          // 缩放平移视图容器
const ivc = $('ivcanvas');
const ivCtx = ivc.getContext('2d');
const side = $('side');
const hint = $('hint');
const badgeEl = $('badge'), busyEl = $('busy');
const fileInfoEl = $('fileInfo'), zoomInfoEl = $('zoomInfo'),
      coordsEl = $('coords'), renderTimeEl = $('renderTime');
const histCanvas = $('hist'), histCtx = histCanvas.getContext('2d');
const progressEl = $('progress');
const val = id => document.getElementById(id);

// 滑块定义
const SLIDERS = {
  ev:   { input: 'sEv',  label: 'vEv',  fmt: v => v.toFixed(1) + ' EV',  preset: 0 },
  br:   { input: 'sBr',  label: 'vBr',  fmt: v => v.toFixed(2),           preset: 1 },
  ct:   { input: 'sCt',  label: 'vCt',  fmt: v => (v > 0 ? '+' : '') + v, preset: 0 },
  sat:  { input: 'sSat', label: 'vSat', fmt: v => v + '%',                preset: 100 },
  hi:   { input: 'sHi',  label: 'vHi',  fmt: v => (v > 0 ? '+' : '') + v, preset: 0 },
  sh:   { input: 'sSh',  label: 'vSh',  fmt: v => (v > 0 ? '+' : '') + v, preset: 0 },
};

// ===================================================================
// 全局状态
// ===================================================================
let cur = null;             // 当前文档 { w, h, src(RGBA8 原解码), meta, raw, name, size, engine }
let curFile = null;
let currentEngine = '1';
let zoom = 1, panX = 0, panY = 0;
let zoomView = false;       // 是否显示缩放视图
let dragging = false, dragStart = null;
let histMode = 'l';
let channelGains = { r: 1, g: 1, b: 1 };
let histVisible = false;
let queue = 0;

// 批量导入的照片列表
let photoList = [];        // [{ file, doc, thumbUrl }]
let currentIdx = -1;       // 当前选中下标
let exporting = false;

// 渲染缓存
let renderCanvas = null;    // 高分辨率离屏
let renderCtx = null;
let currentOut = null;      // Uint8Array(RGBA),renderCanvas 像素
let currentWbLabel = '相机';

// ===================================================================
// 工具
// ===================================================================
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setBadge(text, cls = '') { badgeEl.textContent = text; badgeEl.className = 'status-badge show ' + cls; }
function setBusy(on, msg, sub) {
  busyEl.classList.toggle('show', !!on);
  if (msg) val('pMsg').textContent = msg;
  if (sub) val('pSub').textContent = sub;
  val('barFill').style.width = '0%';
}
function progress(p) { val('barFill').style.width = clamp(p, 0, 100) + '%'; }
function readSliders() {
  return {
    ev: +val('sEv').value, br: +val('sBr').value, ct: +val('sCt').value,
    sat: +val('sSat').value, hi: +val('sHi').value, sh: +val('sSh').value,
  };
}
function updateSliderDisplays() {
  for (const k in SLIDERS) {
    const s = SLIDERS[k];
    val(s.label).textContent = s.fmt(+val(s.input).value);
  }
  val('vWb').textContent = currentWbLabel;
}

// ===================================================================
// 引擎定义:三档质量(对应 dcraw 参数 userQual / halfSize)
// ===================================================================
const ENGINES = {
  1: { label: '标准',   userQual: 3, halfSize: false },
  2: { label: '高质量', userQual: 6, halfSize: false },
  3: { label: '快速',   userQual: 2, halfSize: true  },
};

// ===================================================================
// Linear DNG 检测与内嵌全尺寸 JPEG 提取
//
// Lightroom 等导出工具生成的 Linear DNG 内是已去马赛克的 LinearRaw
// 数据(PhotometricInterpretation=34892)。这类文件往往缺少有效的
// Bayer 阵列与白平衡参数(cam_mul 可能为 [0,1,0,0] 之类的异常值),
// LibRaw 走 LinearRaw 路径时忽略 userMul 等设置,输出整体灰白、
// 褪色,并在特定区域偏绿;而文件内大多还内嵌一张由导出工具渲染的
// 全尺寸 JPEG 预览,颜色准确。这里优先解析出该 JPEG 作为显示来源。
// ===================================================================
function isLinearDng(m) {
  if (!m) return false;
  if ((m.camera_make || '').trim() === 'TIFF') return true;
  const cd = m.color_data;
  if (cd && cd.filters === 0 && cd.colors >= 3 && /RGB/.test(m.cdesc || '')) return true;
  return false;
}

// 解析 TIFF/IFD 链(IFD0 + SubIFDs),找出尺寸最大的内嵌 JPEG 预览
// 返回 { off, len, w, h } 或 null;仅在文件为 JPEG 压缩的 RGB/YCbCr 段中挑选
function extractEmbeddedJpeg(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 16) return null;
  const b0 = dv.getUint16(0);
  if (b0 !== 0x4949 && b0 !== 0x4d4d) return null;      // 'II' / 'MM'
  const le = b0 === 0x4949;
  const u16 = o => dv.getUint16(o, le);
  const u32 = o => dv.getUint32(o, le);
  if (u16(2) !== 42) return null;                        // TIFF magic

  let best = null;

  // 取一条 tag 的首个整数值
  const firstVal = (voff, typ, cnt) => {
    if (!cnt) return 0;
    if (typ === 1) return dv.getUint8(voff);
    if (typ === 3) return dv.getUint16(voff, le);
    if (typ === 4) return dv.getUint32(voff, le);
    return 0;
  };

  const visit = off => {
    if (off <= 0 || off + 2 > dv.byteLength) return;
    const n = u16(off);
    if (!n || off + 2 + n * 12 + 4 > dv.byteLength) return;
    let newSub = 0, w = 0, h = 0, comp = 0, phot = 0;
    let so = 0, sbc = 0, jpgo = 0, jpgl = 0, subIfds = null;
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = u16(e), typ = u16(e + 2), cnt = u32(e + 4);
      const size = typ === 1 ? 1 : typ === 3 ? 2 : typ === 4 ? 4 : typ === 5 ? 8 : 0;
      if (!size || !cnt) continue;
      let voff = e + 8;
      if (size * cnt > 4) voff = u32(e + 8);
      if (voff + size * cnt > dv.byteLength) continue;
      switch (tag) {
        case 0x00fe: newSub = firstVal(voff, typ, cnt); break;              // NewSubfileType
        case 0x0100: w = firstVal(voff, typ, cnt); break;                   // ImageWidth
        case 0x0101: h = firstVal(voff, typ, cnt); break;                   // ImageLength
        case 0x0103: comp = firstVal(voff, typ, cnt); break;                // Compression
        case 0x0106: phot = firstVal(voff, typ, cnt); break;                // PhotometricInterpretation
        case 0x0111: so = firstVal(voff, typ, cnt); break;                  // StripOffsets
        case 0x0117: sbc = firstVal(voff, typ, cnt); break;                 // StripByteCounts
        case 0x0201: jpgo = firstVal(voff, typ, cnt); break;                // JPEGInterchangeFormat
        case 0x0202: jpgl = firstVal(voff, typ, cnt); break;                // JPEGInterchangeFormatLength
        case 0x014a: {                                                      // SubIFDs
          if (typ === 4) { subIfds = []; for (let k = 0; k < cnt; k++) subIfds.push(u32(voff + k * 4)); }
          else if (typ === 3) { subIfds = []; for (let k = 0; k < cnt; k++) subIfds.push(u16(voff + k * 2)); }
          break;
        }
      }
    }
    // 仅考虑 JPEG 压缩(6/7)的 RGB(2)/YCbCr(6)预览,LinearRaw(34892)等跳过
    if ((comp === 6 || comp === 7) && (phot === 2 || phot === 6)) {
      const off = jpgo || so, len = jpgl || sbc;
      if (off > 0 && len > 0 && w > 0 && h > 0 &&
          off + len <= dv.byteLength &&
          dv.getUint8(off) === 0xff && dv.getUint8(off + 1) === 0xd8 &&
          (!best || w * h > best.w * best.h)) {
        best = { off, len, w, h, full: newSub === 1 };
      }
    }
    if (subIfds) for (const s of subIfds) visit(s);
  };

  visit(u32(4));   // IFD0
  return best;
}

// 把内嵌 JPEG 解码为 RGBA8 像素
async function jpegToRgba(buf, off, len) {
  const blob = new Blob([new Uint8Array(buf.slice(off, off + len))], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bitmap.width; c.height = bitmap.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return {
    w: c.width, h: c.height,
    src: new Uint8Array(id.data.buffer.slice(id.data.byteOffset, id.data.byteOffset + id.data.byteLength)),
    format: 'jpeg',
  };
}

// 解码:返回带 src(RGBA8)的文档对象
async function decodeFile(file, engineKey, extraParams = {}) {
  const eng = ENGINES[engineKey];
  const buf = await file.arrayBuffer();

  setBusy(true, '正在解析 RAW 文件…', file.name);
  await new Promise(r => setTimeout(r, 30));

  // ------------------------------------------------------------------
  // 1) Linear DNG:直接用内嵌全尺寸 JPEG 作为显示来源
  //    (LibRaw 解码 LinearRaw 数据输出灰白/褪色/偏绿,见文件头注释)
  // ------------------------------------------------------------------
  if (!extraParams.forceLibRaw) {
    const probeInst = new LibRaw();
    let mProbe = null;
    try {
      await probeInst.open(new Uint8Array(buf.slice(0)), {});
      mProbe = await probeInst.metadata(true);
    } catch (_) {}
    try { probeInst.dispose(); } catch (_) {}
    if (isLinearDng(mProbe)) {
      const jpeg = extractEmbeddedJpeg(buf);
      if (jpeg) {
        setBusy(true, '检测到 Linear DNG,使用内嵌全尺寸 JPEG…', file.name + '  尺寸 ' + jpeg.w + '×' + jpeg.h);
        await new Promise(rr => setTimeout(rr, 30));
        const px = await jpegToRgba(buf, jpeg.off, jpeg.len);
        const doc = { w: px.w, h: px.h, src: px.src, name: file.name, size: file.size, engine: engineKey, linearDng: true };
        doc.embedded = { off: jpeg.off, len: jpeg.len, w: jpeg.w, h: jpeg.h };
        doc.meta = {
          camera_make: 'Linear DNG',
          camera_model: 'Lightroom',
          software: mProbe && mProbe.software,
          width: px.w, height: px.h,
          desc: '线性 DNG(已去马赛克),使用内嵌全尺寸 JPEG 显示。原始 Bayer 数据不在此类文件中。',
        };
        return doc;
      }
    }
    // 非 Linear DNG:继续走 LibRaw(上面的探测实例已释放)
  }

  const bytes = new Uint8Array(buf.slice(0));   // open() 会 detach 缓冲区
  const r = new LibRaw();
  try {
    await r.open(bytes, Object.assign({
      outputBps: 8,
      outputColor: 1,          // sRGB
      userQual: eng.userQual,
      halfSize: eng.halfSize,
      useCameraMatrix: 1,
      outputTiff: false,
      userFlip: -1,
      useCameraWb: true,
      noAutoBright: false,
      autoBrightThr: 0.01,
    }, extraParams));
    progress(50);
    const m = await r.metadata(true);
    const img = await r.imageData();
    progress(90);
    if (!img || !img.width || !img.height || !img.data) throw new Error('LibRaw 未能生成图像');

    const w = img.width, h = img.height;
    const srcD = img.data;
    const src = new Uint8Array(w * h * 4);
    if (srcD.length >= w * h * 3) {
      for (let i = 0, p = 0; i < w * h * 3; i += 3, p += 4) {
        src[p] = srcD[i]; src[p + 1] = srcD[i + 1]; src[p + 2] = srcD[i + 2]; src[p + 3] = 255;
      }
    } else {
      throw new Error('LibRaw 返回的图像数据格式不符');
    }
    progress(100);
    return { raw: r, meta: m, w, h, src, name: file.name, size: file.size, engine: engineKey };
  } catch (e) {
    try { r.dispose(); } catch (_) {}
    throw e;
  }
}

// ===================================================================
// 渲染管线(src -> 显示)
// ===================================================================
const EXP_LUT = new Float32Array(4097);   // 曝光/亮度:输入 v/65535*255 -> 输出
// 注意:索引按 (v/255*4096)|0 计算,v=255 时索引为 4096,因此数组需 4097 项,
// 否则最亮像素取到 undefined,经 |0 变成 0,高光区会显示成绿色光斑。
const TONE_LUT = new Float32Array(256);
const CONTRAST_LUT = new Float32Array(256);
let lutState = { ev: null, br: null, hi: null, sh: null, ct: null };

function rebuildLuts(opts) {
  const { ev, br, hi, sh, ct } = opts;
  const hiAmt = hi / 100, shAmt = sh / 100;
  const gain = Math.pow(2, ev) * br;
  if (ev !== lutState.ev || br !== lutState.br) {
    for (let i = 0; i < 4097; i++) {
      let v = (i / 4096 * 255) * gain;
      v = clamp(v, 0, 255);
      EXP_LUT[i] = v;
    }
  }
  if (hi !== lutState.hi || sh !== lutState.sh) {
    for (let i = 0; i < 256; i++) {
      let t = i / 255;
      t = clamp(t + shAmt * (1 - t) * (0.35 + 0.65 * (1 - t)), 0, 1);
      t = clamp(t - hiAmt * t * (0.35 + 0.65 * t), 0, 1);
      TONE_LUT[i] = t * 255;
    }
  }
  if (ct !== lutState.ct) {
    const c = ct / 100;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let o = c === 0 ? t : 0.5 + Math.sign(t - 0.5) * Math.pow(Math.abs(t - 0.5) * 2, 1 / (1 + c * 0.85)) * 0.5;
      CONTRAST_LUT[i] = clamp(o, 0, 1) * 255;
    }
  }
  lutState.ev = ev; lutState.br = br; lutState.hi = hi; lutState.sh = sh; lutState.ct = ct;
}

// 深度渲染:doc.src(整分辨率 8 位) -> out(Uint8Array)
// extraGains 可选:批量导出时传入导出的通道增益,默认用全局 channelGains
function renderFrame(doc, opts, out, extraGains) {
  const { w, h, src } = doc;
  rebuildLuts(opts);
  const satF = opts.sat / 100;
  const g = extraGains || channelGains;
  const rg = g.r, gg = g.g, bg = g.b;
  const useGain = rg !== 1 || gg !== 1 || bg !== 1;

  const E = EXP_LUT, T = TONE_LUT, C = CONTRAST_LUT;
  const n = w * h;
  let p = 0, q = 0;
  for (let i = 0; i < n; i++) {
    let r = src[p], gv = src[p + 1], b = src[p + 2];
    p += 4;
    // 曝光/亮度
    r = E[(r / 255 * 4096) | 0];
    gv = E[(gv / 255 * 4096) | 0];
    b = E[(b / 255 * 4096) | 0];
    r = r | 0; gv = gv | 0; b = b | 0;
    // 高光/阴影/对比度(查表)
    r = T[r | 0]; gv = T[gv | 0]; b = T[b | 0];
    r = C[r | 0]; gv = C[gv | 0]; b = C[b | 0];
    // 饱和度
    if (satF !== 1) {
      const lum = 0.299 * r + 0.587 * gv + 0.114 * b;
      r = lum + (r - lum) * satF;
      gv = lum + (gv - lum) * satF;
      b = lum + (b - lum) * satF;
    }
    // 增益(自定义白平衡)
    if (useGain) { r *= rg; gv *= gg; b *= bg; }
    out[q++] = r > 255 ? 255 : r;
    out[q++] = gv > 255 ? 255 : gv;
    out[q++] = b > 255 ? 255 : b;
    out[q++] = 255;
  }
}

// ===================================================================
// 直方图
// ===================================================================
function computeHist(rgba, w, h) {
  const hr = new Float32Array(256), hg = new Float32Array(256), hb = new Float32Array(256), hl = new Float32Array(256);
  const step = Math.max(1, Math.floor((w * h) / 600000));
  for (let i = 0; i < w * h; i += step) {
    const p = i * 4;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    hr[r]++; hg[g]++; hb[b]++;
    hl[(r * 299 + g * 587 + b * 114) / 1000 | 0]++;
  }
  return { hr, hg, hb, hl, step };
}

function maxOf(a) { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }

function drawHist(hist) {
  const w = histCanvas.width, h = histCanvas.height;
  histCtx.clearRect(0, 0, w, h);
  if (!hist) return;
  const d = histMode === 'l' ? hist.hl : histMode === 'r' ? hist.hr : histMode === 'g' ? hist.hg : hist.hb;
  const colors = { l: '150,160,175', r: '255,72,77', g: '66,200,120', b: '80,120,255' };
  const c = colors[histMode];
  const maxV = maxOf(d) || 1;
  histCtx.fillStyle = `rgba(${c},0.8)`;
  histCtx.beginPath();
  histCtx.moveTo(0, h);
  for (let x = 0; x < w; x++) {
    const bin = Math.floor(x / w * 256);
    histCtx.lineTo(x, h - Math.max(0.4, d[bin] / maxV * (h - 2)));
  }
  histCtx.lineTo(w, h);
  histCtx.closePath();
  histCtx.fill();
}

function refreshHist() {
  if (!cur || !histVisible) return;
  cur._hist = computeHist(currentOut, cur.w, cur.h);
  drawHist(cur._hist);
}

// ===================================================================
// 视图渲染
// ===================================================================
function ensureRenderCanvas(w, h) {
  if (!renderCanvas || renderCanvas.width !== w || renderCanvas.height !== h) {
    renderCanvas = document.createElement('canvas');
    renderCanvas.width = w; renderCanvas.height = h;
    renderCtx = renderCanvas.getContext('2d');
    currentOut = new Uint8Array(w * h * 4);
  } else if (!currentOut || currentOut.length !== w * h * 4) {
    currentOut = new Uint8Array(w * h * 4);
  }
}

function render() {
  if (!cur) return;
  ensureRenderCanvas(cur.w, cur.h);
  const t0 = performance.now();
  renderFrame(cur, readSliders(), currentOut);
  const imgData = new ImageData(new Uint8ClampedArray(currentOut.buffer, 0, currentOut.length), cur.w, cur.h);
  renderCtx.putImageData(imgData, 0, 0);
  refreshHist();
  renderTimeEl.textContent = '渲染 ' + (performance.now() - t0).toFixed(1) + ' ms';
  drawFit();
  drawZoom();
}

function drawFit() {
  if (!renderCanvas) return;
  const cw = holder.clientWidth, ch = holder.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  fitView.width = cw; fitView.height = ch;
  fitCtx.fillStyle = 'rgba(0,0,0,0)';
  fitCtx.clearRect(0, 0, cw, ch);
  const scale = Math.min(cw / renderCanvas.width, ch / renderCanvas.height);
  if (scale <= 0) return;
  const dw = renderCanvas.width * scale, dh = renderCanvas.height * scale;
  const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  fitCtx.imageSmoothingQuality = 'high';
  fitCtx.drawImage(renderCanvas, dx, dy, dw, dh);
}

function drawZoom() {
  if (!renderCanvas || !zoomView) return;
  const cw = holder.clientWidth, ch = holder.clientHeight;
  const vw = renderCanvas.width * zoom, vh = renderCanvas.height * zoom;
  ivc.width = Math.max(1, Math.round(vw));
  ivc.height = Math.max(1, Math.round(vh));
  ivc.style.width = ivc.width + 'px';
  ivc.style.height = ivc.height + 'px';
  ivCtx.imageSmoothingEnabled = true;
  ivCtx.imageSmoothingQuality = zoom > 4 ? 'medium' : 'high';
  ivCtx.clearRect(0, 0, ivc.width, ivc.height);
  ivCtx.drawImage(renderCanvas, 0, 0, ivc.width, ivc.height);
  ivc.style.left = Math.round(panX + (cw - vw) / 2) + 'px';
  ivc.style.top  = Math.round(panY + (ch - vh) / 2) + 'px';
  zoomInfoEl.textContent = (zoom * 100).toFixed(0) + '%';
}

function setView(kind) {
  zoomView = kind === 'zoom';
  btn('btnZoomView').classList.toggle('active', zoomView);
  iv.style.display = zoomView ? 'block' : 'none';
  hint.style.display = cur ? 'none' : 'block';
  if (zoomView) {
    zoom = 1; panX = 0; panY = 0;
    drawZoom();
  }
  drawFit();
}

function zoomBy(f) { zoom = clamp(zoom * f, 0.1, 40); drawZoom(); }

function zoomAt(f, cx, cy) {
  const showW = holder.clientWidth, showH = holder.clientHeight;
  const rw = renderCanvas.width * zoom, rh = renderCanvas.height * zoom;
  const ox = (showW - rw) / 2, oy = (showH - rh) / 2;
  const mx = (cx - ox - panX) / rw, my = (cy - oy - panY) / rh;
  zoom = clamp(zoom * f, 0.1, 40);
  const nrw = renderCanvas.width * zoom, nrh = renderCanvas.height * zoom;
  panX = cx - (showW - nrw) / 2 - mx * nrw;
  panY = cy - (showH - nrh) / 2 - my * nrh;
  drawZoom();
}

// ===================================================================
// 元数据展示
// ===================================================================
function fmtShutter(s) { if (s >= 1) return s >= 60 ? Math.round(s) + ' s' : s.toFixed(1) + ' s'; return '1/' + Math.round(1 / s); }

function fmtExif(m) {
  if (!m) return {};
  const out = {};
  out['相机型号'] = [m.camera_make, m.camera_model].filter(Boolean).join(' ') || '未知';
  if (m.lens && m.lens['Lens']) out['镜头'] = m.lens['Lens'];
  if (m.iso_speed) out['ISO'] = m.iso_speed;
  if (m.focal_len) out['焦距'] = m.focal_len > 0 ? m.focal_len.toFixed(1) + ' mm' : null;
  if (m.shutter) out['快门'] = fmtShutter(m.shutter);
  if (m.aperture) out['光圈'] = 'f/' + m.aperture.toFixed(1);
  if (m.flip != null && m.flip !== undefined) out['方向'] = { 0: '正常', 3: '旋转180°', 5: '右转90°', 6: '左转90°' }[m.flip] || ('翻转 ' + m.flip);
  if (m.timestamp && m.timestamp instanceof Date && !isNaN(+m.timestamp)) out['拍摄时间'] = m.timestamp.toLocaleString('zh-CN', { hour12: false });
  out['尺寸'] = (m.width || '') + ' × ' + (m.height || '') + ' px';
  if (m.raw_count) out['RAW 张数'] = m.raw_count;
  if (m.dng_version) out['DNG 版本'] = m.dng_version;
  if (m.is_foveon) out['传感器'] = 'Foveon';
  if (m.software) out['软件'] = m.software;
  if (m.artist) out['作者'] = m.artist;
  if (m.desc) out['描述'] = m.desc;
  const cd = m.color_data;
  if (cd) {
    out['传感器黑电平'] = cd.black;
    out['原始深度'] = (cd.raw_bps || 14) + ' bit';
    if (cd.cam_mul && cd.cam_mul.length) out['相机白平衡'] = cd.cam_mul.map(x => x.toFixed(2)).join(' / ');
    if (cd.maximum) out['饱和度上限'] = cd.maximum;
  }
  if (m.metadata_common) {
    const mc = m.metadata_common;
    if (mc.SensorTemperature) out['传感器温度'] = mc.SensorTemperature.toFixed(1) + ' °C';
    if (mc.CameraTemperature) out['机身温度'] = mc.CameraTemperature.toFixed(1) + ' °C';
  }
  return out;
}

function fmtDMS(a, ref) {
  const [d, m, s] = a;
  return `${d}°${m}'${(+s).toFixed(1)}" ${ref}`;
}
function fmtGpsDecimal(a, ref) {
  const [d, m, s] = a;
  return (ref === 'S' || ref === 'W' ? -1 : 1) * (d + m / 60 + s / 3600);
}

function showMetaPanel() {
  const p = val('panelMeta');
  if (!cur) { p.style.display = 'none'; return; }
  const entries = fmtExif(cur.meta);
  let html = '<h3>文件信息</h3><table id="kvtab"><tbody>';
  for (const k in entries) {
    const v = entries[k];
    if (v === null || v === undefined) continue;
    html += `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`;
  }
  html += '</tbody></table>';
  p.innerHTML = html;
  p.style.display = '';
}

function showMapPanel() {
  const p = val('panelMap');
  const gps = cur && cur.meta && cur.meta.gps_data;
  // 需要非零的纬度/经度才显示地图
  const latA = gps && gps.latitude, lonA = gps && gps.longitude;
  const lat = latA ? fmtGpsDecimal(gps.latitude, gps.latref || 'N') : NaN;
  const lon = lonA ? fmtGpsDecimal(gps.longitude, gps.longref || 'E') : NaN;
  const has = latA && lonA && isFinite(lat) && isFinite(lon) &&
              (Math.abs(lat) > 1e-6 || Math.abs(lon) > 1e-6);
  // 只要已加载图片就显示面板:无 GPS 时给出提示
  p.style.display = cur ? '' : 'none';
  if (!has) {
    // 无 GPS 时在面板里给出提示,避免空白
    p.innerHTML = '<h3>拍摄位置</h3><div style="color:var(--dim);font-size:12.5px">该文件未包含 GPS 坐标信息。</div>';
    return;
  }
  const pad = 0.02;
  p.innerHTML =
    `<h3>拍摄位置</h3><table id="kvtab"><tbody>
       <tr><td>纬度</td><td>${lat.toFixed(6)}</td></tr>
       <tr><td>经度</td><td>${lon.toFixed(6)}</td></tr>
       ${gps.altitude != null && !isNaN(gps.altitude) ? `<tr><td>海拔</td><td>${gps.altitude.toFixed(1)} m</td></tr>` : ''}
     </tbody></table>
     <div style="margin-top:10px">
       <iframe style="width:100%;height:220px;border:1px solid var(--border);border-radius:8px;background:#0f1115"
         loading="lazy" referrerpolicy="no-referrer-when-downgrade"
         src="https://www.openstreetmap.org/export/embed.html?bbox=${(lon - pad).toFixed(6)}%2C${(lat - pad / 1.5).toFixed(6)}%2C${(lon + pad).toFixed(6)}%2C${(lat + pad / 1.5).toFixed(6)}&layer=mapnik&marker=${lat.toFixed(6)}%2C${lon.toFixed(6)}"></iframe>
     </div>`;
}

// ===================================================================
// 面板切换
// ===================================================================
function togglePanel(id, btnId) {
  const el = val(id);
  const willShow = el.style.display === 'none' ? true : false;
  if (id === 'panelHist') {
    histVisible = willShow;
    el.style.display = willShow ? '' : 'none';
    btn(btnId).classList.toggle('active', willShow);
    if (willShow && cur && currentOut) refreshHist();
  } else {
    el.style.display = willShow ? '' : 'none';
    btn(btnId).classList.toggle('active', willShow);
    if (id === 'panelMap' && willShow) showMapPanel();
    if (id === 'panelMeta' && willShow) showMetaPanel();
  }
  // 侧栏显隐:只要有任一面板可见就显示侧栏
  const anyVisible = ['panelHist', 'panelMeta', 'panelMap', 'panelAdj']
    .some(p => val(p).style.display !== 'none');
  side.classList.toggle('open', anyVisible);
}

// ---------- 批量导入与导出 ----------
const thumbsEl = val('thumbs');

// 缩略图统一从已解码的全分辨率像素 doc.src 生成,
// 保证清晰(不依赖可能很小或过度压缩的内嵌预览)。
// 用「contain 语义」生成:整张照片完整缩进一个 392×264 的框里,
// 左右留白处用原图边缘颜色填充(不会出现黑边),底部压暗并叠文件名。
// 这样无论横图竖图都能在缩略图里看到照片全貌,不会只露出左上角。
async function makeThumb(entry) {
  try {
    const c = document.createElement('canvas');
    const w = entry.doc.w, h = entry.doc.h;
    const cw = 392, ch = 264;            // 目标框
    const scale = Math.min(cw / w, ch / h);   // contain 语义:整张图都放下
    const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    const img = new ImageData(new Uint8ClampedArray(entry.doc.src.buffer, 0, w * h * 4), w, h);
    // 先在整图画布上用 drawImage 缩放绘制完整照片(drawImage 会缩放,putImageData 不会),
    // 这样整张照片按 contain 语义缩入目标框,不会再出现「只露左上角」的问题。
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(img, 0, 0);
    // 左右/上下留白处用原图四角平均色铺满,避免黑边
    const d = img.data;
    const avg = i => Math.round((d[i] + d[i + 4] + d[i + 8] + d[i + 12]) / 4);
    ctx.fillStyle = `rgb(${avg(0)},${avg(1)},${avg(2)})`;
    ctx.fillRect(0, 0, cw, ch);
    const ox = Math.round((cw - dw) / 2), oy = Math.round((ch - dh) / 2);
    ctx.drawImage(tmp, ox, oy, dw, dh);            // 缩放绘制:整张照片完整缩入框内
    // 底部 1/4 压暗,叠文件名
    const grad = ctx.createLinearGradient(0, ch * 0.72, 0, ch);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, ch * 0.72, cw, ch * 0.28);
    return c.toDataURL('image/jpeg', 0.82);
  } catch (_) {
    return '';
  }
}

function updateThumbBar() {
  thumbsEl.innerHTML = '';
  photoList.forEach((entry, i) => {
    const el = document.createElement('button');
    el.className = 'thumb' + (i === currentIdx ? ' on' : '');
    el.title = entry.file.name;
    el.innerHTML = `<img alt="" src="${entry.thumbUrl}"><span class="filename"></span>`;
    el.querySelector('.filename').textContent = entry.file.name;   // 图片下方的小字标签(缩略图画面内已叠有文件名)
    el.addEventListener('click', () => {
      if (i === currentIdx) return;
      setActivePhoto(i);
    });
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '×';
    rm.title = '从列表移除';
    rm.addEventListener('click', ev => {
      ev.stopPropagation();
      removePhoto(i);
    });
    el.appendChild(rm);
    thumbsEl.appendChild(el);
  });
  val('menuExportAll').disabled = photoList.length === 0;
}

function setActivePhoto(idx) {
  const entry = photoList[idx];
  if (!entry || idx === currentIdx) return;
  if (cur && cur.raw) { try { cur.raw.dispose(); } catch (_) {} }
  cur = entry.doc;
  currentIdx = idx;
  thumbCache = null;
  // 归位滑块与显示参数
  for (const k in SLIDERS) val(SLIDERS[k].input).value = SLIDERS[k].preset;
  channelGains = { r: 1, g: 1, b: 1 };
  lutState = { ev: null, br: null, hi: null, sh: null, ct: null };
  currentWbLabel = '相机';
  updateSliderDisplays();
  document.querySelectorAll('#wbChips .chip').forEach(c => c.classList.toggle('on', c.dataset.wb === 'camera'));
  ensureRenderCanvas(cur.w, cur.h);
  render();
  showMetaPanel(); showMapPanel();
  fileInfoEl.textContent = `${entry.file.name} · ${fmtBytes(entry.file.size)} · ${cur.w}×${cur.h}`;
  if (cur.linearDng) fileInfoEl.textContent += ' · 内嵌全尺寸 JPEG';
  setBadge('就绪', 'ok');
  updateThumbBar();
}

// 批量导入:files 可多选/追加;mode 为 'replace' 或 'append'
async function importFiles(files, mode) {
  if (!files || !files.length) return;
  const arr = Array.from(files);
  hint.style.display = 'none';
  if (mode === 'replace') {
    // 清空旧列表与旧预览资源
    for (const e of photoList) { if (e.thumbUrl) URL.revokeObjectURL(e.thumbUrl); if (e.doc && e.doc.raw) { try { e.doc.raw.dispose(); } catch (_) {} } }
    photoList = []; currentIdx = -1;
    if (cur) { cur = null; renderCanvas = null; renderCtx = null; currentOut = null; }
    thumbsEl.innerHTML = '';
  }
  setBadge('导入中…', '');
  const total = arr.length;
  // 批量导入并行解码:LibRaw 每次实例对应一个独立 Worker(pthread),
  // 串行循环时整批只有单核在解码,浪费多核。改为分批并发,
  // 同一时刻最多并发 CONCURRENCY 个文件同时解码,大幅缩短整体耗时。
  const CONCURRENCY = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 4));
  const results = new Array(total);
  const progressBar = done => {
    const pct = Math.round(done / total * 100);
    val('pMsg').textContent = `正在解析 ${Math.min(done + 1, total)}/${total}…`;
    progress(pct);
  };
  progressBar(0);
  let cursor = 0;
  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      const f = arr[i];
      try {
        const doc = await decodeFile(f, currentEngine);
        const entry = { file: f, doc, thumbUrl: '' };
        results[i] = entry;
        progressBar(i + 1);
      } catch (e) {
        console.error('导入失败', f.name, e);
        results[i] = { error: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));
  // 全部解码完成后再统一生成缩略图与刷新列表
  if (mode === 'replace') {
    for (const e of photoList) { if (e.thumbUrl) URL.revokeObjectURL(e.thumbUrl); if (e.doc && e.doc.raw) { try { e.doc.raw.dispose(); } catch (_) {} } }
    photoList = []; currentIdx = -1;
    if (cur) { cur = null; renderCanvas = null; renderCtx = null; currentOut = null; }
    thumbsEl.innerHTML = '';
  }
  let failCount = 0;
  for (let i = 0; i < total; i++) {
    const r = results[i];
    if (r && !r.error) {
      const entry = r;
      photoList.push(entry);
      try {
        const t = await makeThumb(entry);
        entry.thumbUrl = t;
      } catch (e2) { console.error('缩略图失败', arr[i].name, e2); }
    } else {
      failCount++;
      console.error('导入失败', arr[i].name, r && r.error);
      setBadge(`导入失败: ${arr[i].name}: ${r && r.error && r.error.message || r.error}`, 'err');
    }
  }
  updateThumbBar();
  progressEl.classList.remove('show');
  setBusy(false);
  if (failCount === total) { setBadge('全部导入失败', 'err'); return; }
  if (mode === 'append') {
    // 追加导入:保留当前选中照片
    if (currentIdx < 0 && photoList.length) setActivePhoto(0);
  } else if (photoList.length) {
    // 重新导入:默认选中第一张
    setActivePhoto(0);
  }
  if (photoList.length) { updateThumbBar(); setBadge(`已导入 ${photoList.length} 张`, 'ok'); }
}

function removePhoto(i) {
  const e = photoList[i];
  if (e.thumbUrl) URL.revokeObjectURL(e.thumbUrl);
  if (e.doc && e.doc.raw) { try { e.doc.raw.dispose(); } catch (_) {} }
  photoList.splice(i, 1);
  if (currentIdx === i) {
    currentIdx = -1;
    const next = photoList[i] ? i : i - 1;
    if (next >= 0) setActivePhoto(next);
    else {
      // 列表已清空,回到初始提示态
      cur = null; renderCanvas = null; renderCtx = null; currentOut = null;
      hint.style.display = 'block';
      setBadge('', '');
      fileInfoEl.textContent = '';
      coordsEl.textContent = '';
      renderTimeEl.textContent = '';
      zoomInfoEl.textContent = '100%';
      updateThumbBar();
    }
  } else if (currentIdx > i) {
    currentIdx--;
  }
  updateThumbBar();
}

// ---------- 导出(单张 / 全部打 ZIP 包) ----------
// 所有 JPEG 渲染使用与屏幕一致的调整参数(含自定义白平衡增益)。

// 把 canvas 编码为 JPEG Blob
function canvasToJpegBlob(c) {
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
}

// 单张导出:导出为 JPEG 并触发浏览器下载
async function exportCurrent() {
  if (!renderCanvas) return;
  setBadge('导出中…', '');
  try {
    const blob = await canvasToJpegBlob(renderCanvas);
    if (!blob) throw new Error('JPEG 编码失败');
    downloadBlob(blob, ((curFile && curFile.name || 'raw').replace(/\.[^.]+$/, '')) + '.jpg');
    setBadge('已导出当前照片', 'ok');
  } catch (e) {
    setBadge('导出失败: ' + (e.message || e), 'err');
  }
}

// 文件名附加当前日期时间,如 260918230112(YYMMDDHHMMSS)
function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(-2) + p(d.getMonth() + 1) + p(d.getDate()) +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 触发浏览器下载一个 Blob
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 以某张照片为基础渲染离屏画布(复用当前调整参数,仅供导出)
function renderForExport(doc, opts) {
  const c = document.createElement('canvas');
  c.width = doc.w; c.height = doc.h;
  const ctx = c.getContext('2d');
  const W = doc.w, H = doc.h;
  const out = new Uint8Array(W * H * 4);
  // renderFrame 支持覆盖通道增益(自定义白平衡实时调整),供导出应用
  renderFrame(doc, opts, out, opts._gains);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer, 0, out.length), W, H), 0, 0);
  return c;
}

// 把每张照片导出为 JPEG 并打包成 ZIP 下载
async function exportAllZip() {
  if (!photoList.length) return;
  if (exporting) return;   // 已在进行
  exporting = true;
  // 当前“调整”面板参数将应用于所有照片
  const curOpts = { ...readSliders() };
  curOpts._gains = { ...channelGains };
  const pill = document.createElement('span');
  pill.className = 'progress-pill show';
  pill.id = 'batchPill';
  pill.textContent = '导出中…';
  document.querySelector('header').appendChild(pill);
  setBusy(true, '正在导出全部照片…', '');
  const jpegs = [];   // { name, blob }
  try {
    for (let i = 0; i < photoList.length; i++) {
      const e = photoList[i];
      pill.textContent = `导出中 ${i + 1}/${photoList.length}`;
      setBusy(true, `正在导出 ${i + 1}/${photoList.length}…`, e.file.name);
      // 每张之间让出主线程,避免界面卡顿
      await new Promise(r => setTimeout(r, 30));
      const c = renderForExport(e.doc, curOpts);
      const blob = await canvasToJpegBlob(c);
      c.width = 0; c.height = 0;
      if (!blob) throw new Error('JPEG 编码失败: ' + e.file.name);
      jpegs.push({ name: e.file.name.replace(/\.[^.]+$/, '') + '.jpg', blob });
    }
    const zip = await buildZip(jpegs);
    if (!zip) throw new Error('ZIP 打包失败');
    downloadBlob(zip, 'RAW 导出 ' + timestamp() + '.zip');
    pill.textContent = '完成 ' + jpegs.length + ' 张';
    setBadge('已导出 ' + jpegs.length + ' 张', 'ok');
    setTimeout(() => pill.remove(), 2000);
  } catch (err) {
    console.error('批量导出失败', err);
    pill.remove();
    setBadge('导出失败: ' + (err && err.message || err), 'err');
  } finally {
    exporting = false;
    setBusy(false);
  }
}

// 把所有 JPEG 打包为一个 ZIP 压缩包(用 Canvas 得到的 Blob 构建,不依赖第三方库)。
// 打包规格:local file header 后紧跟文件数据(不打“数据描述符”,压缩方法用 store);
// 文件名一律 UTF-8 并在通用标志置 UTF-8 位,以便中文名被各解压工具正确识别。
// 文件数超过 65535 或总大小超过 4 GiB 时追加 ZIP64 EOCD,保证大目录也能被解压。
async function buildZip(files) {
  const encoder = new TextEncoder();
  // 经典 CRC-32
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf, start, len) => {
    let c = 0xffffffff;
    for (let i = start; i < start + len; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u16 = (arr, o, v) => { arr[o] = v & 255; arr[o + 1] = (v >>> 8) & 255; };
  const u32 = (arr, o, v) => { arr[o] = v & 255; arr[o + 1] = (v >>> 8) & 255; arr[o + 2] = (v >>> 16) & 255; arr[o + 3] = (v >>> 24) & 255; };
  // 1990 年初作为默认日期(纯 store 打包,解压方不关心该时间)
  const d = new Date(1990, 0, 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);

  // 生成一个安全的 zip 内条目名:去目录分隔、前缀下划线防止以点开头被当作隐藏文件
  function safeName(n) {
    let s = String(n).replace(/\\/g, '/').replace(/^.*\//, '');
    if (!s || s.startsWith('.')) s = '_' + s;
    return s;
  }

  const parts = [];
  let offset = 0;
  const central = [];
  let totalSize = 0;
  for (const f of files) {
    const name = encoder.encode(safeName(f.name));
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const crc = crc32(data, 0, data.length);
    totalSize += data.length;

    const lh = new Uint8Array(30 + name.length);   // 本地文件头
    u32(lh, 0, 0x04034b50);
    u16(lh, 4, 20);            // 版本
    u16(lh, 6, 0x0800);        // 通用标志:UTF-8 文件名(无数据描述符)
    u16(lh, 8, 0);             // 压缩方法:存储(不压缩)
    u16(lh, 10, dosTime);
    u16(lh, 12, dosDate);
    u32(lh, 14, crc);
    u32(lh, 18, data.length);  // 压缩后大小
    u32(lh, 22, data.length);  // 未压缩大小
    u16(lh, 26, name.length);
    u16(lh, 28, 0);            // 文件名长度 + 额外字段长度均为 0
    lh.set(name, 30);
    parts.push(lh, data);

    const ch = new Uint8Array(46 + name.length);   // 中央目录记录
    u32(ch, 0, 0x02014b50);
    u16(ch, 4, 20); u16(ch, 6, 20);
    u16(ch, 8, 0x0800);
    u16(ch, 10, 0);
    u16(ch, 12, dosTime);
    u16(ch, 14, dosDate);
    u32(ch, 16, crc);
    u32(ch, 20, data.length);
    u32(ch, 24, data.length);
    u16(ch, 28, name.length);
    u16(ch, 30, 0);            // 额外字段长度
    u16(ch, 32, 0);            // 注释长度
    u16(ch, 34, 0);            // 磁盘号
    u16(ch, 36, 0);            // 内部属性
    u32(ch, 38, 0);            // 外部属性(普通文件)
    u32(ch, 42, offset);
    ch.set(name, 46);
    central.push(ch);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const needZip64 = central.length > 0xffff || offset > 0xffffffff;

  // 中央目录结束记录
  const eocd = new Uint8Array(22);
  u32(eocd, 0, 0x06054b50);
  u16(eocd, 4, 0);             // 磁盘号
  u16(eocd, 6, 0);             // 起始磁盘号
  u16(eocd, 8, central.length);
  u16(eocd, 10, central.length);
  u32(eocd, 12, centralSize);
  u32(eocd, 16, offset);
  if (needZip64) {
    // 放不下时用占位值(0xffff / 0xffffffff),真实值写入 ZIP64 EOCD
    u16(eocd, 8, 0xffff); u16(eocd, 10, 0xffff);
    u32(eocd, 12, 0xffffffff); u32(eocd, 16, 0xffffffff);
  }
  // 中央目录记录逐条推入 parts(不能把数组整体作为 BlobPart,否则会被 toString 成文本)
  for (const c of central) parts.push(c);
  if (needZip64) {
    // ZIP64 扩展记录(固定 56 字节),紧跟 EOCD 之前
    const z64 = new Uint8Array(56);
    u32(z64, 0, 0x06064b50);
    u32(z64, 4, 44);           // 记录大小(后续 44 字节)
    u32(z64, 8, 45);           // 版本
    u32(z64, 12, 45);
    u32(z64, 16, 0);           // 磁盘数
    u32(z64, 20, 0);
    u32(z64, 24, central.length);
    u32(z64, 28, central.length);
    u32(z64, 32, centralSize);
    u32(z64, 40, offset);
    u32(z64, 48, 1);           // 可定位记录数
    parts.push(z64);
    const loc = new Uint8Array(20);   // ZIP64 定位记录
    u32(loc, 0, 0x07064b50);
    u32(loc, 4, 0);
    u32(loc, 8, offset + centralSize);
    u32(loc, 12, 1);
    parts.push(loc);
  }
  parts.push(eocd);
  return new Blob(parts, { type: 'application/zip' });
}

// ---------- 打开文件(单图/批量) ----------
async function openFile(file, engineKey) {
  if (!file) return;
  curFile = file;
  hint.style.display = 'none';
  progressEl.classList.add('show');
  badgeEl.classList.remove('show');
  queue++;
  try {
    const doc = await decodeFile(file, engineKey);
    if (cur && cur.raw) { try { cur.raw.dispose(); } catch (_) {} }
    cur = doc;
    currentEngine = engineKey;
    thumbCache = null;   // 新实例,内嵌预览缓存失效
    highlightEngine(engineKey);

    for (const k in SLIDERS) { val(SLIDERS[k].input).value = SLIDERS[k].preset; }
    channelGains = { r: 1, g: 1, b: 1 };
    lutState = { ev: null, br: null, hi: null, sh: null, ct: null };
    currentWbLabel = '相机';
    updateSliderDisplays();
    document.querySelectorAll('#wbChips .chip').forEach(c => c.classList.toggle('on', c.dataset.wb === 'camera'));

    ensureRenderCanvas(cur.w, cur.h);
    render();
    showMetaPanel();
    showMapPanel();
    fileInfoEl.textContent = `${file.name} · ${fmtBytes(file.size)} · ${cur.w}×${cur.h}`;
    if (cur.linearDng) fileInfoEl.textContent += ' · 内嵌全尺寸 JPEG';
    setBadge('就绪', 'ok');
    // 调整功能使用频率高:打开后自动展开「调整」面板
    if (val('panelAdj').style.display === 'none') togglePanel('panelAdj', 'btnAdj');
    setView('fit');   // 打开后默认适应窗口,不进入放大查看
  } catch (e) {
    console.error(e);
    setBadge('解码失败: ' + (e && e.message || e), 'err');
  } finally {
    queue--;
    progressEl.classList.remove('show');
    if (queue === 0) setBusy(false);
  }
}

// ===================================================================
// 事件
// ===================================================================
btn('btnOpen').addEventListener('click', () => val('file').click());
val('file').addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) importFiles(files, 'replace');
});
btn('btnOpenMore').addEventListener('click', () => val('fileMore').click());
val('fileMore').addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) importFiles(files, 'append');
});

// 拖放
let dropDepth = 0;
window.addEventListener('dragenter', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dropDepth++; val('content').classList.add('drop');
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => {
  dropDepth--; if (dropDepth <= 0) { dropDepth = 0; val('content').classList.remove('drop'); }
});
window.addEventListener('drop', e => {
  e.preventDefault(); dropDepth = 0; val('content').classList.remove('drop');
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) importFiles(files, 'replace');
});

// 窗口尺寸
window.addEventListener('resize', debounce(() => { drawFit(); drawZoom(); }, 150));

// 滑块
for (const k in SLIDERS) {
  const s = SLIDERS[k];
  val(s.input).addEventListener('input', () => {
    val(s.label).textContent = s.fmt(+val(s.input).value);
    render();
  });
}

// 缩放按钮
btn('btnZoomIn').addEventListener('click', () => zoomBy(1.25));
btn('btnZoomOut').addEventListener('click', () => zoomBy(0.8));
btn('btnFit').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; setView('zoom'); drawZoom(); });
btn('btn100').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; drawZoom(); });

// 滚轮缩放
iv.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = iv.getBoundingClientRect();
  zoomAt(1.15 ** (e.deltaY * (e.deltaMode === 1 ? -0.05 : -0.0015)), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

// 平移
iv.addEventListener('mousedown', e => {
  dragging = true; dragStart = { x: e.clientX, y: e.clientY, px: panX, py: panY };
  ivc.classList.add('dragging');
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  panX = dragStart.px + (e.clientX - dragStart.x);
  panY = dragStart.py + (e.clientY - dragStart.y);
  drawZoom();
});
window.addEventListener('mouseup', () => { dragging = false; ivc.classList.remove('dragging'); });

// 像素拾取(适应视图)
fitView.addEventListener('click', e => {
  if (!renderCanvas) return;
  const rect = fitView.getBoundingClientRect();
  const scale = fitView.width / renderCanvas.width;
  const dx = (fitView.width - renderCanvas.width * scale) / 2;
  const x = Math.floor((e.clientX - rect.left - dx) / scale);
  const y = Math.floor((e.clientY - rect.top) / scale);
  if (x < 0 || y < 0 || x >= renderCanvas.width || y >= renderCanvas.height) return;
  const p = (y * renderCanvas.width + x) * 4;
  const d = currentOut;
  val('pixel').style.display = '';
  val('pixel').innerHTML = `坐标 <b>${x}, ${y}</b> · RGB <b>${d[p]}, ${d[p + 1]}, ${d[p + 2]}</b>`;
  coordsEl.textContent = `${x}, ${y}`;
});

// 直方图通道
document.querySelectorAll('#chanRow .chan').forEach(ch => {
  ch.addEventListener('click', () => {
    document.querySelectorAll('#chanRow .chan').forEach(c => c.classList.remove('on'));
    ch.classList.add('on');
    histMode = ch.dataset.c;
    drawHist(cur && cur._hist);
  });
});

// 面板按钮
btn('btnHist').addEventListener('click', () => togglePanel('panelHist', 'btnHist'));
btn('btnMeta').addEventListener('click', () => togglePanel('panelMeta', 'btnMeta'));
btn('btnMap').addEventListener('click', () => togglePanel('panelMap', 'btnMap'));
btn('btnAdj').addEventListener('click', () => togglePanel('panelAdj', 'btnAdj'));
btn('btnZoomView').addEventListener('click', () => setView(zoomView ? 'fit' : 'zoom'));

// 白平衡预设(需要重新解码,由 LibRaw 应用)
const WB_PRESETS = {
  camera:      { label: '相机',   extra: { useCameraWb: true,  useAutoWb: false } },
  auto:        { label: '自动',   extra: { useCameraWb: false, useAutoWb: true  } },
  daylight:    { label: '日光',   extra: { useCameraWb: false, useAutoWb: false, userMul: [1.0, 1.0, 1.0, 1.0] } },
  cloudy:      { label: '阴天',   extra: { useCameraWb: false, useAutoWb: false, userMul: [1.15, 1.0, 0.45, 1.0] } },
  shade:       { label: '阴影',   extra: { useCameraWb: false, useAutoWb: false, userMul: [1.4, 1.0, 0.35, 1.0] } },
  flash:       { label: '闪光灯', extra: { useCameraWb: false, useAutoWb: false, userMul: [1.1, 1.0, 0.5, 1.0] } },
  tungsten:    { label: '钨丝灯', extra: { useCameraWb: false, useAutoWb: false, userMul: [0.6, 1.0, 1.6, 1.0] } },
  fluorescent: { label: '荧光灯', extra: { useCameraWb: false, useAutoWb: false, userMul: [0.7, 1.0, 1.3, 1.0] } },
  custom:      { label: '自定义', extra: null },
};

document.querySelectorAll('#wbChips .chip').forEach(ch => {
  ch.addEventListener('click', async () => {
    const key = ch.dataset.wb;
    document.querySelectorAll('#wbChips .chip').forEach(c => c.classList.remove('on'));
    ch.classList.add('on');
    currentWbLabel = WB_PRESETS[key].label;
    val('vWb').textContent = currentWbLabel;
    val('wbCustomRow').style.display = key === 'custom' ? '' : 'none';

    if (key === 'custom') {
      // 浏览器端 RGB 增益,无需重新解码
      render();
      return;
    }
    if (!curFile) return;
    setBusy(true, '正在重新解码…', '应用白平衡 ' + WB_PRESETS[key].label);
    try {
      const doc = await decodeFile(curFile, currentEngine, WB_PRESETS[key].extra || {});
      if (cur && cur.raw) { try { cur.raw.dispose(); } catch (_) {} }
      cur = doc;
      thumbCache = null;   // 新实例,内嵌预览缓存失效
      lutState = { ev: null, br: null, hi: null, sh: null, ct: null };
      channelGains = { r: 1, g: 1, b: 1 };
      ensureRenderCanvas(cur.w, cur.h);
      render();
      setBadge('就绪', 'ok');
    } catch (e) {
      console.error(e);
      setBadge('白平衡失败: ' + (e && e.message || e), 'err');
    } finally { setBusy(false); }
  });
});

// 自定义白平衡(浏览器端实时)
val('sWbR').addEventListener('input', () => {
  channelGains.r = +val('sWbR').value; val('vWbR').textContent = channelGains.r.toFixed(2); render();
});
val('sWbG').addEventListener('input', () => {
  channelGains.g = +val('sWbG').value; val('vWbG').textContent = channelGains.g.toFixed(2); render();
});
val('sWbB').addEventListener('input', () => {
  channelGains.b = +val('sWbB').value; val('vWbB').textContent = channelGains.b.toFixed(2); render();
});

// 引擎切换
document.querySelectorAll('.engines .badge').forEach(b => {
  b.addEventListener('click', async () => {
    const eng = b.dataset.eng;
    if (!curFile) return;
    setBusy(true, '切换质量档位…', ENGINES[eng].label);
    b.classList.add('busy');
    try {
      await openFile(curFile, eng);
    } catch (e) {
      console.error(e);
      setBadge('切换失败: ' + (e.message || e), 'err');
    } finally {
      b.classList.remove('busy');
      setBusy(false);
    }
  });
});

// 引擎高亮:进入解码流程时,把对应档位标记为高亮
function highlightEngine(key) {
  document.querySelectorAll('.engines .badge').forEach(b =>
    b.classList.toggle('on', b.dataset.eng === String(key)));
}

// 导出:下拉菜单(导出当前照片 / 导出全部照片为 ZIP)
const exportMenu = val('exportMenu');
btn('btnExportMenu').addEventListener('click', e => {
  e.stopPropagation();
  const open = exportMenu.style.display === 'block';
  exportMenu.style.display = open ? 'none' : 'block';
});
// 点击外部关闭菜单
window.addEventListener('click', e => {
  if (!e.target.closest('#exportMenuWrap')) exportMenu.style.display = 'none';
});
// Esc 关闭菜单
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') exportMenu.style.display = 'none';
});
val('menuExportOne').addEventListener('click', () => {
  exportMenu.style.display = 'none';
  exportCurrent();
});
val('menuExportAll').addEventListener('click', () => {
  exportMenu.style.display = 'none';
  exportAllZip();
});

// 内嵌预览图
let thumbCache = null;   // 缓存 {data, format},避免同一实例重复解包
btn('btnThumb').addEventListener('click', async () => {
  if (!cur) return;
  setBusy(true, '读取内嵌预览…');
  try {
    // Linear DNG 没有可用的 LibRaw thumb;直接用提取到的内嵌 JPEG
    if (cur.linearDng && cur.embedded) {
      const blob = new Blob([new Uint8Array(cur.src.buffer.slice(cur.embedded.off, cur.embedded.off + cur.embedded.len))], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const w = window.open('', 'thumb');
      if (!w) throw new Error('浏览器阻止了弹出窗口');
      w.document.write(`<html><head><meta charset="utf-8"><title>内嵌预览 - ${escapeHtml(curFile ? curFile.name : '')}</title></head><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${url}" style="max-width:100%;max-height:100%"></body></html>`);
      w.document.close();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    if (!thumbCache) {   // 同一 LibRaw 实例只能成功解码一次内嵌预览,失败也不缓存
      const t = await cur.raw.thumbnailData();
      if (!t || !t.data || !t.data.length) throw new Error('该文件无内嵌预览图');
      thumbCache = { data: t.data, format: t.format };
    }
    const blob = new Blob([thumbCache.data], thumbCache.format === 'jpeg' ? { type: 'image/jpeg' } : { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const w = window.open('', 'thumb');
    if (!w) throw new Error('浏览器阻止了弹出窗口');
    w.document.write(`<html><head><meta charset="utf-8"><title>内嵌预览 - ${escapeHtml(curFile ? curFile.name : '')}</title></head><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${url}" style="max-width:100%;max-height:100%"></body></html>`);
    w.document.close();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    setBadge('预览图读取失败: ' + (e.message || e), 'warn');
  } finally { setBusy(false); }
});

// 白天 / 黑夜主题切换(默认白天,持久化到 localStorage)
const THEME_LS = 'rawviewer-theme';
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const btn = val('btnTheme');
  if (mode === 'dark') { btn.textContent = '☀️'; btn.title = '切换到白天外观'; }
  else                { btn.textContent = '🌙'; btn.title = '切换到黑夜外观'; }
  try { localStorage.setItem(THEME_LS, mode); } catch (_) {}
}
val('btnTheme').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
try { applyTheme(localStorage.getItem(THEME_LS) === 'dark' ? 'dark' : 'light'); } catch (_) { applyTheme('light'); }

// 初始化
setView('none');
updateSliderDisplays();