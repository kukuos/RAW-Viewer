// 右侧面板:直方图 / 信息 / 位置 / 调整(Tabs 切换)
import { useEffect, useRef, useState } from 'react'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { computeHist, maxOf, type AdjustOpts } from '@/lib/render'
import { fmtBytes, fmtExif } from '@/lib/format'
import type { RawDoc } from '@/lib/rawEngine'
import type { WbGains } from '@/hooks/useRawViewer'
import { WB_PRESETS } from '@/hooks/useRawViewer'

interface Props {
  panel: string
  cur: RawDoc | null
  currentOut: Uint8Array | null
  adjust: AdjustOpts
  onAdjust: (patch: Partial<AdjustOpts>) => void
  wbKey: string
  onWb: (key: string, gains?: WbGains) => void
  gains: WbGains
  onGains: (g: WbGains) => void
  onDraggingChange: (d: boolean) => void
}

function Histogram({ cur, currentOut }: { cur: RawDoc | null; currentOut: Uint8Array | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const modeRef = useRef<'l' | 'r' | 'g' | 'b'>('l')
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    if (!cur || !currentOut) {
      cv.getContext('2d')!.clearRect(0, 0, cv.width, cv.height)
      return
    }
    const hist = computeHist(currentOut, cur.w, cur.h)
    drawHistCanvas(cv, hist, modeRef.current)
  }, [cur, currentOut])
  return (
    <div className="flex flex-col gap-2">
      <canvas ref={ref} width={300} height={90} className="h-[90px] w-full rounded border bg-card" />
      <div className="flex justify-between text-[11px] text-muted-foreground"><span>0</span><span>255</span></div>
      <div className="flex gap-1">
        {(['l', 'r', 'g', 'b'] as const).map(k => (
          <button
            key={k}
            className={`rounded px-2 py-0.5 text-[11px] ${modeRef.current === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            onClick={() => {
              modeRef.current = k
              const cv = ref.current
              if (cv && cur && currentOut) drawHistCanvas(cv, computeHist(currentOut, cur.w, cur.h), k)
            }}
          >
            {k === 'l' ? '明亮度' : k.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}

// 画直方图(复用 render 模块无 DOM 依赖的绘制)
function drawHistCanvas(cv: HTMLCanvasElement, hist: ReturnType<typeof computeHist>, mode: 'l' | 'r' | 'g' | 'b') {
  const ctx = cv.getContext('2d')!
  const w = cv.width, h = cv.height
  ctx.clearRect(0, 0, w, h)
  const d = hist[mode === 'l' ? 'hl' : mode === 'r' ? 'hr' : mode === 'g' ? 'hg' : 'hb']
  const colors = { l: '150,160,175', r: '255,72,77', g: '66,200,120', b: '80,120,255' }
  const maxV = maxOf(d) || 1
  ctx.fillStyle = `rgba(${colors[mode]},0.8)`
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let x = 0; x < w; x++) {
    const bin = Math.floor(x / w * 256)
    ctx.lineTo(x, h - Math.max(0.4, d[bin] / maxV * (h - 2)))
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fill()
}

const SLIDERS: { key: keyof AdjustOpts; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'ev', label: '曝光', min: -3, max: 3, step: 0.1, fmt: v => v.toFixed(1) + ' EV' },
  { key: 'br', label: '亮度', min: 0.2, max: 4, step: 0.05, fmt: v => v.toFixed(2) },
  { key: 'ct', label: '对比度', min: -100, max: 100, step: 1, fmt: v => (v > 0 ? '+' : '') + v },
  { key: 'sat', label: '饱和度', min: 0, max: 200, step: 1, fmt: v => v + '%' },
  { key: 'hi', label: '高光', min: -100, max: 100, step: 1, fmt: v => (v > 0 ? '+' : '') + v },
  { key: 'sh', label: '阴影', min: -100, max: 100, step: 1, fmt: v => (v > 0 ? '+' : '') + v },
]

interface AdjustProps {
  adjust: AdjustOpts
  onAdjust: (patch: Partial<AdjustOpts>) => void
  wbKey: string
  onWb: (key: string, gains?: WbGains) => void
  gains: WbGains
  onGains: (g: WbGains) => void
  onDraggingChange: (d: boolean) => void
}

function Adjust({ adjust, onAdjust, wbKey, onWb, gains, onGains, onDraggingChange }: AdjustProps) {
  const [dragStamp, setDragStamp] = useState(0)
  useEffect(() => {
    // 滑块松手(最后 onChange 后 150ms 无新事件)切回全分辨率渲染
    if (dragStamp > 0) {
      const t = setTimeout(() => onDraggingChange(false), 150)
      return () => clearTimeout(t)
    }
  }, [dragStamp, onDraggingChange])
  return (
    <div className="flex flex-col gap-4">
      {SLIDERS.map(s => (
        <div key={s.key} className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">{s.label}</Label>
            <span className="font-mono text-xs text-primary">{s.fmt(adjust[s.key])}</span>
          </div>
          <Slider
            value={[adjust[s.key]]}
            min={s.min}
            max={s.max}
            step={s.step}
            onValueChange={v => {
              onDraggingChange(true)
              setDragStamp(Date.now())
              onAdjust({ [s.key]: v[0] } as Partial<AdjustOpts>)
            }}
          />
        </div>
      ))}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">白平衡</Label>
          <span className="text-xs text-primary">{WB_PRESETS[wbKey]?.label || wbKey}</span>
        </div>
        <Select value={wbKey} onValueChange={v => onWb(v)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(WB_PRESETS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {wbKey === 'custom' && (
        <div className="space-y-2">
          {(['r', 'g', 'b'] as const).map(c => (
            <div key={c} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">{c.toUpperCase()} 增益</Label>
                <span className="font-mono text-xs text-primary">{gains[c].toFixed(2)}</span>
              </div>
              <Slider
                value={[gains[c]]}
                min={0.4}
                max={2.5}
                step={0.01}
                onValueChange={v => onGains({ ...gains, [c]: v[0] })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MetaPanel({ cur }: { cur: RawDoc | null }) {
  if (!cur) return <div className="text-xs text-muted-foreground">无数据</div>
  const entries = fmtExif(cur.meta as Record<string, unknown> | undefined)
  return (
    <div className="space-y-1 text-xs">
      <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">文件信息</div>
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2 border-b border-dashed py-1">
          <span className="w-20 shrink-0 text-muted-foreground">{k}</span>
          <span className="break-all font-mono text-foreground">{v}</span>
        </div>
      ))}
      <div className="pt-2 text-muted-foreground">{cur.name} · {fmtBytes(cur.size)}</div>
    </div>
  )
}

function MapPanel({ cur }: { cur: RawDoc | null }) {
  const gps = (cur?.meta as Record<string, unknown> | undefined)?.gps_data as { latitude?: number[]; longitude?: number[]; latref?: string; longref?: string; altitude?: number } | undefined
  const latA = gps?.latitude, lonA = gps?.longitude
  const fmtDMS = (a: number[], ref: string) => {
    const [d, m, s] = a
    return `${d}°${m}'${(+s).toFixed(1)}" ${ref}`
  }
  const fmtDec = (a: number[], ref: string) => {
    const [d, m, s] = a
    return ((ref === 'S' || ref === 'W') ? -1 : 1) * (d + m / 60 + s / 3600)
  }
  if (!latA || !lonA || latA.length < 3 || lonA.length < 3) {
    return <div className="text-xs text-muted-foreground">该文件未包含 GPS 坐标信息。</div>
  }
  const lat = fmtDec(latA, gps.latref || 'N')
  const lon = fmtDec(lonA, gps.longref || 'E')
  if (!isFinite(lat) || !isFinite(lon) || (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)) {
    return <div className="text-xs text-muted-foreground">该文件未包含有效的 GPS 坐标信息。</div>
  }
  const pad = 0.02
  return (
    <div className="space-y-2 text-xs">
      <div className="flex gap-2"><span className="w-20 text-muted-foreground">纬度</span><span className="font-mono">{fmtDMS(latA, gps.latref || 'N')}</span></div>
      <div className="flex gap-2"><span className="w-20 text-muted-foreground">经度</span><span className="font-mono">{fmtDMS(lonA, gps.longref || 'E')}</span></div>
      {gps.altitude != null && !isNaN(gps.altitude) && (
        <div className="flex gap-2"><span className="w-20 text-muted-foreground">海拔</span><span className="font-mono">{gps.altitude.toFixed(1)} m</span></div>
      )}
      <iframe
        title="map"
        className="h-[220px] w-full rounded border bg-card"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        src={`https://www.openstreetmap.org/export/embed.html?bbox=${(lon - pad).toFixed(6)}%2C${(lat - pad / 1.5).toFixed(6)}%2C${(lon + pad).toFixed(6)}%2C${(lat + pad / 1.5).toFixed(6)}&layer=mapnik&marker=${lat.toFixed(6)}%2C${lon.toFixed(6)}`}
      />
    </div>
  )
}

export function SidePanel(props: Props) {
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l bg-card p-3">
      {props.panel === 'hist' && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">直方图</div>
          <Histogram cur={props.cur} currentOut={props.currentOut} />
        </div>
      )}
      {props.panel === 'meta' && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">信息</div>
          <MetaPanel cur={props.cur} />
        </div>
      )}
      {props.panel === 'map' && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">位置</div>
          <MapPanel cur={props.cur} />
        </div>
      )}
      {props.panel === 'adj' && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">渲染调整</div>
          <Adjust
            adjust={props.adjust}
            onAdjust={props.onAdjust}
            wbKey={props.wbKey}
            onWb={props.onWb}
            gains={props.gains}
            onGains={props.onGains}
            onDraggingChange={props.onDraggingChange}
          />
        </div>
      )}
      {props.panel === 'zoom' && (
        <div className="text-xs text-muted-foreground">滚轮缩放,按住拖动平移。工具栏的 适应 / 100% 可复位。</div>
      )}
    </aside>
  )
}
