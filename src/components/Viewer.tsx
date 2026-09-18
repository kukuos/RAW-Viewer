// 中央大图区:canvas 渲染(适应窗口 + 放大平移),空状态提示,进度浮层
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { FolderOpen } from 'lucide-react'
import { renderToCanvas } from '@/lib/render'
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
}

export function Viewer({ cur, adjust, gains, zoomView, onOpen, importState, zoomApiRef, onPixelPick }: Props) {
  const fitRef = useRef<HTMLCanvasElement>(null)
  const ivRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const renderCache = useRef<HTMLCanvasElement | null>(null)
  const currentOutRef = useRef<Uint8Array | null>(null)

  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const zoomViewRef = useRef(zoomView)
  zoomViewRef.current = zoomView

  function draw() {
    const rc = renderCache.current
    const fit = fitRef.current, iv = ivRef.current, wrap = wrapRef.current
    if (!rc || !fit || !iv || !wrap) return
    const cw = wrap.clientWidth, ch = wrap.clientHeight
    if (cw <= 0 || ch <= 0) return

    fit.width = cw; fit.height = ch
    const ctx = fit.getContext('2d')!
    ctx.clearRect(0, 0, cw, ch)
    const scale = Math.min(cw / rc.width, ch / rc.height)
    const dw = rc.width * scale, dh = rc.height * scale
    const dx = (cw - dw) / 2, dy = (ch - dh) / 2
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(rc, dx, dy, dw, dh)

    if (zoomViewRef.current) {
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
    const rc = renderToCanvas(cur, adjust, gains)
    renderCache.current = rc
    const ctx = rc.getContext('2d')!
    const id = ctx.getImageData(0, 0, rc.width, rc.height)
    currentOutRef.current = new Uint8Array(id.data.buffer.slice(id.data.byteOffset, id.data.byteOffset + id.data.byteLength))
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, adjust, gains])

  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 缩放 API
  if (zoomApiRef) {
    zoomApiRef.current = {
      zoomIn: () => { zoomRef.current = Math.min(40, zoomRef.current * 1.25); draw() },
      zoomOut: () => { zoomRef.current = Math.max(0.1, zoomRef.current * 0.8); draw() },
      fit: () => { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; draw() },
      hundred: () => { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; draw() },
    }
  }

  function onWheel(e: React.WheelEvent) {
    if (!zoomViewRef.current) return
    e.preventDefault()
    const wrap = wrapRef.current!
    const rect = wrap.getBoundingClientRect()
    const rc = renderCache.current!
    const showW = wrap.clientWidth, showH = wrap.clientHeight
    const rw = rc.width * zoomRef.current, rh = rc.height * zoomRef.current
    const ox = (showW - rw) / 2, oy = (showH - rh) / 2
    const mx = (e.clientX - rect.left - ox - panRef.current.x) / rw
    const my = (e.clientY - rect.top - oy - panRef.current.y) / rh
    const f = 1.15 ** (e.deltaY * (e.deltaMode === 1 ? -0.05 : -0.0015))
    zoomRef.current = Math.min(40, Math.max(0.1, zoomRef.current * f))
    const nrw = rc.width * zoomRef.current, nrh = rc.height * zoomRef.current
    panRef.current.x = (e.clientX - rect.left) - (showW - nrw) / 2 - mx * nrw
    panRef.current.y = (e.clientY - rect.top) - (showH - nrh) / 2 - my * nrh
    draw()
  }

  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  function onMouseDown(e: React.MouseEvent) {
    if (!zoomViewRef.current) return
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

  // 像素拾取(适应视图)
  function onFitClick(e: React.MouseEvent) {
    if (!renderCache.current || !onPixelPick) return
    const fit = fitRef.current!
    const rect = fit.getBoundingClientRect()
    const scale = fit.width / renderCache.current.width
    const dx = (fit.width - renderCache.current.width * scale) / 2
    const x = Math.floor((e.clientX - rect.left - dx) / scale)
    const y = Math.floor((e.clientY - rect.top) / scale)
    if (x < 0 || y < 0 || x >= renderCache.current.width || y >= renderCache.current.height) return
    const d = currentOutRef.current
    if (!d) return
    const p = (y * renderCache.current.width + x) * 4
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
