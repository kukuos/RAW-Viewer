// 中央大图区:canvas 渲染(适应窗口 + 放大平移),空状态提示,进度浮层
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { FolderOpen } from 'lucide-react'
import { renderToCanvas, renderPreviewCanvas } from '@/lib/render'
import type { AdjustOpts } from '@/lib/render'
import type { RawDoc } from '@/lib/rawEngine'
import type { WbGains, ImportState } from '@/hooks/useRawViewer'

export interface ZoomApi {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  hundred: () => void
}

interface Props {
  cur: RawDoc | null
  adjust: AdjustOpts
  gains: WbGains
  zoomView: boolean
  onOpen: () => void
  importState: ImportState
  zoomApiRef?: React.MutableRefObject<ZoomApi | null>
  onPixelPick?: (x: number, y: number, rgb: [number, number, number]) => void
  adjusting?: boolean
}

export function Viewer({ cur, adjust, gains, zoomView, onOpen, importState, zoomApiRef, onPixelPick, adjusting }: Props) {
  const fitRef = useRef<HTMLCanvasElement>(null)
  const ivRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const renderCache = useRef<HTMLCanvasElement | null>(null)
  const currentOutRef = useRef<Uint8Array | null>(null)

  const fitZoom = useRef(1)            // 普通视图:相对适应窗口的倍数(1 = 适应)
  const zoomRef = useRef(1)            // 放大查看:相对原始像素的倍数(1 = 100%)
  const panRef = useRef({ x: 0, y: 0 })
  const zoomViewRef = useRef(zoomView)
  zoomViewRef.current = zoomView

  // 缩放视图的像素拾取:点击 iv 画布时按缩放系数换算回原图坐标
  const pickFromZoom = (e: React.MouseEvent, iv: HTMLCanvasElement) => {
    const rc = renderCache.current
    if (!rc) return null
    const rect = iv.getBoundingClientRect()
    const x = Math.floor((e.clientX - rect.left) / zoomRef.current)
    const y = Math.floor((e.clientY - rect.top) / zoomRef.current)
    if (x < 0 || y < 0 || x >= rc.width || y >= rc.height) return null
    return { x, y }
  }

  function draw() {
    const rc = renderCache.current
    const fit = fitRef.current, iv = ivRef.current, wrap = wrapRef.current
    if (!rc || !fit || !wrap) return
    const cw = wrap.clientWidth, ch = wrap.clientHeight
    if (cw <= 0 || ch <= 0) return

    fit.width = cw; fit.height = ch
    const ctx = fit.getContext('2d')!
    ctx.clearRect(0, 0, cw, ch)
    const fitScale = Math.min(cw / rc.width, ch / rc.height)  // 适应窗口时的缩放比

    if (zoomViewRef.current && iv) {
      // 放大查看视图:fit 画布始终显示适应窗口完整图
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(rc, (cw - rc.width * fitScale) / 2, (ch - rc.height * fitScale) / 2, rc.width * fitScale, rc.height * fitScale)

      // 缩放画布按原始分辨率 * zoomRef(1 = 100% 原始像素)
      const z = zoomRef.current, px = panRef.current.x, py = panRef.current.y
      const vw = rc.width * z, vh = rc.height * z
      iv.width = Math.max(1, Math.round(vw))
      iv.height = Math.max(1, Math.round(vh))
      const ictx = iv.getContext('2d')!
      ictx.imageSmoothingEnabled = true
      ictx.imageSmoothingQuality = z > 4 ? 'medium' : 'high'
      ictx.clearRect(0, 0, iv.width, iv.height)
      ictx.drawImage(rc, 0, 0, iv.width, iv.height)
      iv.style.width = iv.width + 'px'
      iv.style.height = iv.height + 'px'
      iv.style.left = Math.round(px + (cw - vw) / 2) + 'px'
      iv.style.top = Math.round(py + (ch - vh) / 2) + 'px'
    } else {
      // 非缩放视图:fitZoom 相对适应窗口(1 = 完整显示),fit 画布按倍数放大
      const z = fitZoom.current, px = panRef.current.x, py = panRef.current.y
      const dw = rc.width * fitScale * z, dh = rc.height * fitScale * z
      ctx.save()
      ctx.imageSmoothingQuality = 'high'
      ctx.translate(Math.round((cw - dw) / 2 + px), Math.round((ch - dh) / 2 + py))
      ctx.drawImage(rc, 0, 0, dw, dh)
      ctx.restore()
    }
  }

  // 渲染整分辨率离屏画布并绘制 fit / zoom 视图
  useEffect(() => {
    if (!cur) {
      renderCache.current = null
      currentOutRef.current = null
      const fit = fitRef.current
      if (fit) { fit.width = 0; fit.height = 0 }
      return
    }
    // 拖动滑块时用降采样预览渲染,松手后全分辨率,保证拖动丝滑
    const rc = adjusting ? renderPreviewCanvas(cur, adjust, gains, 960) : renderToCanvas(cur, adjust, gains)
    renderCache.current = rc
    const ctx = rc.getContext('2d')!
    const id = ctx.getImageData(0, 0, rc.width, rc.height)
    currentOutRef.current = new Uint8Array(id.data.buffer.slice(id.data.byteOffset, id.data.byteOffset + id.data.byteLength))
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, adjust, gains, adjusting])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    // 用 ResizeObserver 监听容器尺寸变化(首次布局、侧栏/状态栏变化时兜底重绘)
    const ro = new ResizeObserver(() => draw())
    ro.observe(wrap)
    window.addEventListener('resize', () => draw())
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', () => draw())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换缩放视图时需要重新绘制(否则 zoom 画布保持默认空白)
  useEffect(() => {
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomView])

  // 缩放 API:普通视图用 fitZoom(1=适应),放大查看用 zoomRef(1=100% 原始像素)
  if (zoomApiRef) {
    zoomApiRef.current = {
      zoomIn: () => {
        if (zoomViewRef.current) zoomRef.current = Math.min(40, zoomRef.current * 1.25)
        else fitZoom.current = Math.min(40, fitZoom.current * 1.2)
        draw()
      },
      zoomOut: () => {
        if (zoomViewRef.current) zoomRef.current = Math.max(0.05, zoomRef.current * 0.8)
        else fitZoom.current = Math.max(0.05, fitZoom.current * 0.833)
        draw()
      },
      fit: () => { fitZoom.current = 1; zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; draw() },
      hundred: () => {
        // 放大查看:显示 100% 原始像素;普通视图:相对 fit 放大到 100%
        if (zoomViewRef.current) {
          zoomRef.current = 1
        } else {
          const wrap = wrapRef.current!, rc = renderCache.current!
          const fitScale = Math.min(wrap.clientWidth / rc.width, wrap.clientHeight / rc.height)
          fitZoom.current = 1 / fitScale
        }
        panRef.current = { x: 0, y: 0 }
        draw()
      },
    }
  }

  function onWheel(e: React.WheelEvent) {
    // 任意视图都允许缩放:滚轮以光标为中心缩放
    e.preventDefault()
    const wrap = wrapRef.current!
    const rect = wrap.getBoundingClientRect()
    const rc = renderCache.current!
    const showW = wrap.clientWidth, showH = wrap.clientHeight
    const fitScale = Math.min(showW / rc.width, showH / rc.height)
    const isZoomView = zoomViewRef.current
    const z = isZoomView ? zoomRef.current : fitZoom.current
    // 显示尺寸(放大查看 = 原始像素 * zoomRef;普通 = 适应尺寸 * fitZoom)
    const rw = isZoomView ? rc.width * z : rc.width * fitScale * z
    const rh = isZoomView ? rc.height * z : rc.height * fitScale * z
    const ox = (showW - rw) / 2, oy = (showH - rh) / 2
    const mx = (e.clientX - rect.left - ox - panRef.current.x) / rw
    const my = (e.clientY - rect.top - oy - panRef.current.y) / rh
    const fRaw = 1.1 ** (e.deltaMode === 1 ? -e.deltaY : -e.deltaY / 120)
    // 限制单格缩放幅度:一次滚轮最多 ~±25%,避免高灵敏度滚轮/触控板一次猛跳
    const f = Math.min(1.25, Math.max(0.8, fRaw))
    const nz = Math.min(40, Math.max(0.05, z * f))
    if (isZoomView) zoomRef.current = nz; else fitZoom.current = nz
    const nrw = isZoomView ? rc.width * nz : rc.width * fitScale * nz
    const nrh = isZoomView ? rc.height * nz : rc.height * fitScale * nz
    panRef.current.x = (e.clientX - rect.left) - (showW - nrw) / 2 - mx * nrw
    panRef.current.y = (e.clientY - rect.top) - (showH - nrh) / 2 - my * nrh
    draw()
  }

  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  function onMouseDown(e: React.MouseEvent) {
    // 任意视图都允许拖拽平移
    drag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y }
    ivRef.current?.classList.add('cursor-grabbing')
    e.preventDefault()
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!drag.current) return
      panRef.current.x = drag.current.px + (e.clientX - drag.current.x)
      panRef.current.y = drag.current.py + (e.clientY - drag.current.y)
      draw()
    }
    function onUp() {
      drag.current = null
      ivRef.current?.classList.remove('cursor-grabbing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 像素拾取(适应视图 + 缩放视图)
  function onFitClick(e: React.MouseEvent) {
    if (!renderCache.current || !onPixelPick) return
    const rc = renderCache.current
    const iv = ivRef.current
    const isZoom = zoomViewRef.current && iv
    let x: number, y: number
    if (isZoom) {
      const p = pickFromZoom(e, iv)
      if (!p) return
      x = p.x; y = p.y
    } else {
      const fit = fitRef.current!
      const rect = fit.getBoundingClientRect()
      const scale = fit.width / rc.width
      const dx = (fit.width - rc.width * scale) / 2
      x = Math.floor((e.clientX - rect.left - dx) / scale)
      y = Math.floor((e.clientY - rect.top) / scale)
      if (x < 0 || y < 0 || x >= rc.width || y >= rc.height) return
    }
    const d = currentOutRef.current
    if (!d) return
    const p = (y * rc.width + x) * 4
    onPixelPick(x, y, [d[p], d[p + 1], d[p + 2]])
  }

  return (
    <div ref={wrapRef} className="relative flex-1 overflow-hidden" onWheel={onWheel}>
      <canvas ref={fitRef} className="absolute inset-0 h-full w-full cursor-default" onMouseDown={onMouseDown} onClick={onFitClick} />
      {zoomView && (
        <canvas
          ref={ivRef}
          className="absolute cursor-grab"
          style={{ position: 'absolute', left: 0, top: 0, display: 'block' }}
          onClick={onFitClick}
        />
      )}

      {!cur && !importState.phase && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="text-5xl">📷</div>
          <div className="max-w-md leading-relaxed text-muted-foreground">
            点击 <b className="text-foreground">「打开 RAW…」</b> 或将 RAW 文件<b className="text-foreground">拖入此窗口</b>
            <br />
            支持 CR2 / CR3 / NEF / ARW / RAF / RW2 / ORF / PEF / DNG 等常见格式
            <br />
            <span className="text-xs text-muted-foreground/80">全部处理在本地浏览器内完成,不会上传任何数据</span>
          </div>
          <Button className="pointer-events-auto" onClick={onOpen} size="lg">
            <FolderOpen className="size-4" /> 打开 RAW…
          </Button>
        </div>
      )}

      {importState.phase && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/60">
          <div className="w-72 rounded-xl border bg-card p-6 shadow-lg">
            <div className="mb-4 flex flex-col items-center gap-3">
              <span className="inline-block size-8 animate-spin rounded-full border-[3px] border-muted border-t-primary" />
              <div className="text-center text-sm font-semibold">
                {importState.phase === 'decoding'
                  ? `正在解析照片 ${Math.min(importState.done + 1, importState.total)}/${importState.total}`
                  : `正在生成缩略图 ${importState.done}/${importState.total}`}
              </div>
              <div className="text-center text-xs text-muted-foreground">
                {importState.phase === 'decoding' ? `${importState.total} 张照片,请稍候…` : '即将完成…'}
              </div>
            </div>
            <Progress value={importState.total ? (importState.done / importState.total) * 100 : 0} />
          </div>
        </div>
      )}
    </div>
  )
}
