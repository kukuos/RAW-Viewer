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

// 解码:返回带 src(RGBA8)的文档对象
async function decodeFile(file, engineKey, extraParams = {}) {
  const eng = ENGINES[engineKey];
  const buf = await file.arrayBuffer();

  setBusy(true, '正在解析 RAW 文件…', file.name);
  await new Promise(r => setTimeout(r, 30));

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
const EXP_LUT = new Float32Array(4096);   // 曝光/亮度:输入 v/65535*255 -> 输出
const TONE_LUT = new Float32Array(256);
const CONTRAST_LUT = new Float32Array(256);
let lutState = { ev: null, br: null, hi: null, sh: null, ct: null };

function rebuildLuts(opts) {
  const { ev, br, hi, sh, ct } = opts;
  const hiAmt = hi / 100, shAmt = sh / 100;
  const gain = Math.pow(2, ev) * br;
  if (ev !== lutState.ev || br !== lutState.br) {
    for (let i = 0; i < 4096; i++) {
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
function renderFrame(doc, opts, out) {
  const { w, h, src } = doc;
  rebuildLuts(opts);
  const satF = opts.sat / 100;
  const g = channelGains;
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

// ===================================================================
// 打开文件
// ===================================================================
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
    setBadge('就绪', 'ok');
    setView('zoom');
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
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openFile(f, currentEngine);
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
  const f = e.dataTransfer.files[0];
  if (f) openFile(f, currentEngine);
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

// 导出
btn('btnExport').addEventListener('click', () => {
  if (!renderCanvas) return;
  const scale = 1;   // 渲染结果本身已含所有调整,原尺寸导出即可
  const ex = document.createElement('canvas');
  ex.width = renderCanvas.width; ex.height = renderCanvas.height;
  ex.getContext('2d').drawImage(renderCanvas, 0, 0);
  ex.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((curFile && curFile.name || 'raw').replace(/\.[^.]+$/, '')) + '.jpg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/jpeg', 0.92);
});

// 内嵌预览图
let thumbCache = null;   // 缓存 {data, format},避免同一实例重复解包
btn('btnThumb').addEventListener('click', async () => {
  if (!cur) return;
  setBusy(true, '读取内嵌预览…');
  try {
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

// 初始化
setView('none');
updateSliderDisplays();