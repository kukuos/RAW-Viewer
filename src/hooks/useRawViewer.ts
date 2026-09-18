// 全局状态管理:照片列表、当前文档、调整参数、导入进度、导出状态
import { useCallback, useMemo, useRef, useState } from 'react'
import type { RawDoc } from '@/lib/rawEngine'
import { decodeFile, ENGINES } from '@/lib/rawEngine'
import type { AdjustOpts } from '@/lib/render'
import { ADJUST_PRESET } from '@/lib/render'

export interface PhotoEntry {
  file: File
  doc: RawDoc
  thumbUrl: string
}

export type ImportPhase = 'decoding' | 'thumbs' | null

export interface ImportState {
  phase: ImportPhase
  done: number
  total: number
}

export interface WbGains {
  r: number
  g: number
  b: number
}

export const WB_PRESETS: Record<string, { label: string; extra?: Record<string, unknown> | null }> = {
  camera:      { label: '相机', extra: { useCameraWb: true, useAutoWb: false } },
  auto:        { label: '自动', extra: { useCameraWb: false, useAutoWb: true } },
  daylight:    { label: '日光', extra: { useCameraWb: false, useAutoWb: false, userMul: [1.0, 1.0, 1.0, 1.0] } },
  cloudy:      { label: '阴天', extra: { useCameraWb: false, useAutoWb: false, userMul: [1.15, 1.0, 0.45, 1.0] } },
  shade:       { label: '阴影', extra: { useCameraWb: false, useAutoWb: false, userMul: [1.4, 1.0, 0.35, 1.0] } },
  flash:       { label: '闪光灯', extra: { useCameraWb: false, useAutoWb: false, userMul: [1.1, 1.0, 0.5, 1.0] } },
  tungsten:    { label: '钨丝灯', extra: { useCameraWb: false, useAutoWb: false, userMul: [0.6, 1.0, 1.6, 1.0] } },
  fluorescent: { label: '荧光灯', extra: { useCameraWb: false, useAutoWb: false, userMul: [0.7, 1.0, 1.3, 1.0] } },
  custom:      { label: '自定义', extra: null },
}

export function useRawViewer() {
  const [photoList, setPhotoList] = useState<PhotoEntry[]>([])
  const [currentIdx, setCurrentIdx] = useState(-1)
  const [currentEngine, setCurrentEngine] = useState('1')
  const [adjust, setAdjust] = useState<AdjustOpts>({ ...ADJUST_PRESET })
  const [wbKey, setWbKey] = useState('camera')
  const [gains, setGains] = useState<WbGains>({ r: 1, g: 1, b: 1 })
  const [importState, setImportState] = useState<ImportState>({ phase: null, done: 0, total: 0 })
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'err' | 'warn' | 'info' }>({ text: '', kind: 'info' })
  const [currentFile, setCurrentFile] = useState<File | null>(null)

  const cur = currentIdx >= 0 ? photoList[currentIdx]?.doc ?? null : null
  const listRef = useRef(photoList)
  listRef.current = photoList

  const disposeDoc = (d: RawDoc | null | undefined) => {
    if (d?.raw) { try { d.raw.dispose() } catch { /* ignore */ } }
  }

  const updateAdjust = useCallback((patch: Partial<AdjustOpts>) => {
    setAdjust(prev => ({ ...prev, ...patch }))
  }, [])

  const setWb = useCallback((key: string, gainsPatch?: WbGains) => {
    setWbKey(key)
    if (gainsPatch) setGains(gainsPatch)
  }, [])

  // 批量导入:并行解码,解码完成后生成缩略图
  const importFiles = useCallback(async (files: File[], mode: 'replace' | 'append') => {
    if (!files.length) return
    const arr = Array.from(files)
    const total = arr.length

    if (mode === 'replace') {
      listRef.current.forEach(e => disposeDoc(e.doc))
      setPhotoList([])
      setCurrentIdx(-1)
    }

    setImportState({ phase: 'decoding', done: 0, total })
    const results = new Array<PhotoEntry | { error: Error }>(total)
    const CONCURRENCY = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 4))
    let cursor = 0
    let completed = 0

    async function worker() {
      while (cursor < total) {
        const i = cursor++
        const f = arr[i]
        try {
          const doc = await decodeFile(f, currentEngine)
          results[i] = { file: f, doc, thumbUrl: '' }
        } catch (e) {
          console.error('导入失败', f.name, e)
          results[i] = { error: e as Error }
        }
        completed++
        setImportState({ phase: 'decoding', done: completed, total })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()))

    if (mode === 'replace') {
      listRef.current.forEach(e => disposeDoc(e.doc))
      setPhotoList([])
      setCurrentIdx(-1)
    }

    let failCount = 0
    const entries: PhotoEntry[] = []
    setImportState({ phase: 'thumbs', done: 0, total })
    for (let i = 0; i < total; i++) {
      const r = results[i]
      if (r && !('error' in r)) {
        entries.push(r)
      } else {
        failCount++
        const err = (r as { error: Error })?.error
        console.error('导入失败', arr[i].name, err)
        setStatus({ text: `导入失败: ${arr[i].name}: ${err?.message || err}`, kind: 'err' })
      }
      setImportState({ phase: 'thumbs', done: i + 1, total })
    }

    // 生成缩略图(makeThumbDataUrl 在 render.ts)
    const { makeThumbDataUrl } = await import('@/lib/render')
    for (const e of entries) {
      try {
        e.thumbUrl = makeThumbDataUrl(e.doc)
      } catch (e2) { console.error('缩略图失败', e.file.name, e2) }
    }

    setPhotoList(prev => (mode === 'append' ? [...prev, ...entries] : entries))
    setImportState({ phase: null, done: 0, total: 0 })
    if (failCount === total) { setStatus({ text: '全部导入失败', kind: 'err' }); return }
    setStatus({ text: `已导入 ${entries.length} 张`, kind: 'ok' })
    // 追加模式保留当前选中;replace 默认选第一张
    if (mode === 'append') {
      if (currentIdx < 0 && entries.length) {
        const idx = photoList.length
        setCurrentIdx(idx)
      }
    } else if (entries.length) {
      setCurrentIdx(0)
    }
  }, [currentEngine, currentIdx, photoList.length])

  const selectPhoto = useCallback((idx: number) => {
    if (idx < 0 || idx >= listRef.current.length || idx === currentIdx) return
    setCurrentIdx(idx)
  }, [currentIdx])

  const removePhoto = useCallback((idx: number) => {
    const list = listRef.current
    const e = list[idx]
    if (e) disposeDoc(e.doc)
    const next = [...list.slice(0, idx), ...list.slice(idx + 1)]
    setPhotoList(next)
    if (currentIdx === idx) {
      if (next.length === 0) {
        setCurrentIdx(-1)
        setStatus({ text: '', kind: 'info' })
      } else {
        setCurrentIdx(Math.min(idx, next.length - 1))
      }
    } else if (currentIdx > idx) {
      setCurrentIdx(currentIdx - 1)
    }
  }, [currentIdx])

  const applyWbPreset = useCallback(async (key: string) => {
    const preset = WB_PRESETS[key]
    setWbKey(key)
    if (key === 'custom') return
    const f = currentFile
    if (!f) return
    setStatus({ text: '正在重新解码… ' + preset.label, kind: 'info' })
    try {
      const doc = await decodeFile(f, currentEngine, preset.extra || {})
      const list = listRef.current
      if (currentIdx >= 0 && currentIdx < list.length) {
        disposeDoc(list[currentIdx].doc)
        const updated = [...list]
        updated[currentIdx] = { ...updated[currentIdx], doc }
        setPhotoList(updated)
      } else {
        disposeDoc(doc)
      }
      setGains({ r: 1, g: 1, b: 1 })
      setStatus({ text: '就绪', kind: 'ok' })
    } catch (e) {
      console.error(e)
      setStatus({ text: '白平衡失败: ' + (e as Error)?.message, kind: 'err' })
    }
  }, [currentEngine, currentFile, currentIdx])

  const switchEngine = useCallback(async (eng: string) => {
    if (!currentFile) return
    setStatus({ text: '切换质量档位… ' + ENGINES[eng].label, kind: 'info' })
    try {
      const doc = await decodeFile(currentFile, eng)
      const list = listRef.current
      if (currentIdx >= 0 && currentIdx < list.length) {
        disposeDoc(list[currentIdx].doc)
        const updated = [...list]
        updated[currentIdx] = { ...updated[currentIdx], doc, file: currentFile }
        setPhotoList(updated)
      } else {
        disposeDoc(doc)
      }
      setCurrentEngine(eng)
      setGains({ r: 1, g: 1, b: 1 })
      setStatus({ text: '就绪', kind: 'ok' })
    } catch (e) {
      console.error(e)
      setStatus({ text: '切换失败: ' + (e as Error)?.message, kind: 'err' })
    }
  }, [currentEngine, currentFile, currentIdx])

  const storeCurrentFile = useCallback((f: File | null) => setCurrentFile(f), [])

  return useMemo(() => ({
    photoList, currentIdx, cur, currentEngine, adjust, updateAdjust,
    wbKey, setWb, gains, setGains,
    importState, setImportState, exporting, setExporting,
    status, setStatus, currentFile, storeCurrentFile,
    importFiles, selectPhoto, removePhoto, applyWbPreset, switchEngine,
  }), [
    photoList, currentIdx, cur, currentEngine, adjust, updateAdjust,
    wbKey, setWb, gains, setGains, importState, exporting, status,
    currentFile, storeCurrentFile, importFiles, selectPhoto, removePhoto,
    applyWbPreset, switchEngine,
  ])
}
