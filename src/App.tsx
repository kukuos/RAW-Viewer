// 主应用:三列布局(左缩略图 / 中央大图 / 右面板)+ 顶栏
import { useCallback, useEffect, useRef, useState } from 'react'
import { Toolbar } from '@/components/Toolbar'
import { ThumbColumn } from '@/components/ThumbColumn'
import { Viewer, type ZoomApi } from '@/components/Viewer'
import { SidePanel } from '@/components/SidePanel'
import { Badge } from '@/components/ui/badge'
import { useRawViewer } from '@/hooks/useRawViewer'
import { useTheme } from '@/hooks/useTheme'
import { renderToCanvas } from '@/lib/render'
import { fmtBytes, canvasToJpegBlob, downloadBlob, buildZip, timestamp } from '@/lib/format'

export default function App() {
  const rw = useRawViewer()
  const { theme, toggleTheme } = useTheme()
  const [panel, setPanel] = useState('adj')
  const [zoomView, setZoomView] = useState(false)
  const [renderTime, setRenderTime] = useState('')
  const [currentOut, setCurrentOut] = useState<Uint8Array | null>(null)
  const [coords, setCoords] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const fileMore = useRef<HTMLInputElement>(null)
  const zoomApi = useRef<ZoomApi | null>(null)

  const {
    photoList, currentIdx, cur, currentEngine, adjust, updateAdjust,
    wbKey, gains, setGains, importState, exporting, setExporting,
    status, setStatus, storeCurrentFile, importFiles, selectPhoto, removePhoto,
    applyWbPreset, switchEngine,
  } = rw

  // 渲染当前照片:生成离屏画布并交由 Viewer;同时维护 currentOut 供直方图
  useEffect(() => {
    if (!cur) { setCurrentOut(null); setRenderTime(''); return }
    const t0 = performance.now()
    const c = renderToCanvas(cur, adjust, gains)
    const ctx = c.getContext('2d')!
    const id = ctx.getImageData(0, 0, c.width, c.height)
    setCurrentOut(new Uint8Array(id.data.buffer.slice(id.data.byteOffset, id.data.byteOffset + id.data.byteLength)))
    setRenderTime('渲染 ' + (performance.now() - t0).toFixed(1) + ' ms')
  }, [cur, adjust, gains])

  const onOpenClick = useCallback(() => fileInput.current?.click(), [])
  const onAppendClick = useCallback(() => fileMore.current?.click(), [])

  const doImport = useCallback(async (files: FileList | File[], mode: 'replace' | 'append') => {
    const arr = Array.from(files)
    if (!arr.length) return
    if (arr[0]) storeCurrentFile(arr[0])
    await importFiles(arr, mode)
  }, [importFiles, storeCurrentFile])

  const onExportOne = useCallback(async () => {
    if (!cur) return
    setStatus({ text: '导出中…', kind: 'info' })
    try {
      const c = renderToCanvas(cur, adjust, gains)
      const blob = await canvasToJpegBlob(c)
      if (!blob) throw new Error('JPEG 编码失败')
      const name = (cur.name.replace(/\.[^.]+$/, '') || 'raw') + '.jpg'
      downloadBlob(blob, name)
      setStatus({ text: '已导出当前照片', kind: 'ok' })
    } catch (e) {
      setStatus({ text: '导出失败: ' + ((e as Error)?.message || e), kind: 'err' })
    }
  }, [cur, adjust, gains, setStatus])

  const onExportAll = useCallback(async () => {
    if (!photoList.length || exporting) return
    setExporting(true)
    const curOpts = { ...adjust }
    try {
      const jpegs: { name: string; blob: Blob }[] = []
      for (let i = 0; i < photoList.length; i++) {
        const e = photoList[i]
        setStatus({ text: `正在导出 ${i + 1}/${photoList.length}…`, kind: 'info' })
        await new Promise(r => setTimeout(r, 30))
        const c = renderToCanvas(e.doc, curOpts, gains)
        const blob = await canvasToJpegBlob(c)
        c.width = 0; c.height = 0
        if (!blob) throw new Error('JPEG 编码失败: ' + e.file.name)
        jpegs.push({ name: e.file.name.replace(/\.[^.]+$/, '') + '.jpg', blob })
      }
      const zip = await buildZip(jpegs)
      downloadBlob(zip, 'RAW 导出 ' + timestamp() + '.zip')
      setStatus({ text: '已导出 ' + jpegs.length + ' 张', kind: 'ok' })
    } catch (err) {
      console.error('批量导出失败', err)
      setStatus({ text: '导出失败: ' + ((err as Error)?.message || err), kind: 'err' })
    } finally {
      setExporting(false)
    }
  }, [photoList, exporting, adjust, gains, setExporting, setStatus])

  const onPixelPick = useCallback((x: number, y: number, rgb: [number, number, number]) => {
    setCoords(`${x}, ${y} · RGB ${rgb[0]}, ${rgb[1]}, ${rgb[2]}`)
  }, [])

  // 打开后默认展开「调整」面板
  useEffect(() => {
    if (cur) setPanel('adj')
  }, [cur])

  const handlePanel = useCallback((p: string) => {
    setPanel(p)
    setZoomView(p === 'zoom')
  }, [])

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <input ref={fileInput} type="file" multiple accept=".cr2,.cr3,.nef,.nrw,.arw,.srf,.sr2,.raf,.rw2,.orf,.pef,.dng,.raw,.iiq,.3fr,.kdc,.dcr,.mrw,.erf,.mef,.x3f,.gpr,.srw,.bay,.fff,.mos,.ptx,.rwl" className="hidden"
        onChange={e => { const f = e.target.files; e.target.value = ''; if (f?.length) doImport(f, 'replace') }} />
      <input ref={fileMore} type="file" multiple accept=".cr2,.cr3,.nef,.nrw,.arw,.srf,.sr2,.raf,.rw2,.orf,.pef,.dng,.raw,.iiq,.3fr,.kdc,.dcr,.mrw,.erf,.mef,.x3f,.gpr,.srw,.bay,.fff,.mos,.ptx,.rwl" className="hidden"
        onChange={e => { const f = e.target.files; e.target.value = ''; if (f?.length) doImport(f, 'append') }} />

      <Toolbar
        onOpen={onOpenClick}
        onAppend={onAppendClick}
        onExportOne={onExportOne}
        onExportAll={onExportAll}
        onZoomIn={() => zoomApi.current?.zoomIn()}
        onZoomOut={() => zoomApi.current?.zoomOut()}
        onFit={() => { setZoomView(true); zoomApi.current?.fit() }}
        on100={() => zoomApi.current?.hundred()}
        engine={currentEngine}
        onEngine={eng => switchEngine(eng)}
        panel={panel}
        onPanel={handlePanel}
        canExport={!!cur}
        exporting={exporting}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <div
        className="flex min-h-0 flex-1"
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          const files = Array.from(e.dataTransfer.files || [])
          if (files.length) doImport(files, 'replace')
        }}
      >
        <ThumbColumn list={photoList} currentIdx={currentIdx} onSelect={selectPhoto} onRemove={removePhoto} />

        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Viewer
              cur={cur}
              adjust={adjust}
              gains={gains}
              zoomView={zoomView}
              onOpen={onOpenClick}
              importState={importState}
              zoomApiRef={zoomApi}
              onPixelPick={onPixelPick}
            />
          </div>

          <div className="flex items-center gap-4 border-t bg-card px-3 py-1 text-xs text-muted-foreground">
            <span>
              {cur ? `${cur.name} · ${fmtBytes(cur.size)} · ${cur.w}×${cur.h}${cur.linearDng ? ' · 内嵌全尺寸 JPEG' : ''}` : '—'}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span>{zoomView ? '缩放视图' : '适应窗口'}</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="font-mono">{coords}</span>
            <span style={{ flex: 1 }} />
            <span className="font-mono">{renderTime}</span>
            {status.text && (
              <Badge variant={status.kind === 'err' ? 'destructive' : status.kind === 'ok' ? 'default' : 'secondary'}>
                {status.text}
              </Badge>
            )}
          </div>
        </main>

        <SidePanel
          panel={panel}
          cur={cur}
          currentOut={currentOut}
          adjust={adjust}
          onAdjust={updateAdjust}
          wbKey={wbKey}
          onWb={key => applyWbPreset(key)}
          gains={gains}
          onGains={g => setGains(g)}
        />
      </div>
    </div>
  )
}
