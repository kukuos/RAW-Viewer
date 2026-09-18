// LibRaw WASM 封装:在 Web Worker 中运行 worker.js,提供 open/metadata/imageData 等 Promise API
// worker.js 内部通过 import.meta.url 相对加载同目录的 libraw.js 与 libraw.wasm(public/ 静态资源)

export interface LibRawMeta {
  camera_make?: string
  camera_model?: string
  software?: string
  width?: number
  height?: number
  desc?: string
  timestamp?: Date
  iso_speed?: number
  focal_len?: number
  shutter?: number
  aperture?: number
  flip?: number
  raw_count?: number
  dng_version?: string
  is_foveon?: boolean
  artist?: string
  lens?: Record<string, string>
  color_data?: {
    filters?: number
    colors?: number
    black?: number
    raw_bps?: number
    cam_mul?: number[]
    maximum?: number
  }
  metadata_common?: {
    SensorTemperature?: number
    CameraTemperature?: number
  }
  gps_data?: {
    latitude?: number[]
    longitude?: number[]
    latref?: string
    longref?: string
    altitude?: number
  }
  cdesc?: string
  thumb_format?: string
}

export interface LibRawImageData {
  width?: number
  height?: number
  data?: Uint8Array
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class LibRaw {
  private worker: Worker
  private pending = new Map<number, Pending>()
  private nextId = 0
  private tail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor() {
    // 用纯字符串相对路径创建 Worker:Vite 不会重打包字符串路径的 worker,
    // 相对路径按页面 URL 解析 —— dev 根路径与 GitHub Pages 子路径下都落到 public/libraw/worker.js。
    // worker.js 内部再相对加载同目录的 libraw.js 与 libraw.wasm。
    this.worker = new Worker('./libraw/worker.js', { type: 'module' })
    this.worker.onmessage = ({ data }: MessageEvent) => {
      const p = this.pending.get(data?.id)
      if (p) {
        this.pending.delete(data.id)
        data?.error ? p.reject(new Error(data.error)) : p.resolve(data?.out)
      }
    }
  }

  dispose() {
    this.disposed = true
    this.worker.terminate()
    for (const { reject } of this.pending.values()) reject(new Error('LibRaw disposed'))
    this.pending.clear()
  }

  private runFn(fn: string, ...args: unknown[]): Promise<unknown> {
    const call = () =>
      new Promise<unknown>((resolve, reject) => {
        if (this.disposed) {
          reject(new Error('LibRaw disposed'))
          return
        }
        const id = this.nextId++
        this.pending.set(id, { resolve, reject })
        // 传递 transferable(typed array 的 buffer),避免拷贝大块像素
        const transfer = args
          .map(a => {
            if (a instanceof ArrayBuffer) return a
            if (a instanceof Uint8Array || a instanceof Int8Array || a instanceof Uint16Array ||
                a instanceof Int16Array || a instanceof Uint32Array || a instanceof Int32Array ||
                a instanceof Float32Array || a instanceof Float64Array) {
              return a.buffer as ArrayBuffer
            }
            return undefined
          })
          .filter((b): b is ArrayBuffer => b !== undefined)
        this.worker.postMessage({ id, fn, args }, transfer)
      })
    const p = this.tail.then(call, call)
    this.tail = p.then(() => undefined, () => undefined)
    return p
  }

  async open(buffer: Uint8Array, opts: Record<string, unknown> = {}): Promise<void> {
    await this.runFn('open', buffer, opts)
  }

  async metadata(verbose = false): Promise<LibRawMeta> {
    const m = (await this.runFn('metadata', verbose)) as LibRawMeta | null
    if (m?.hasOwnProperty('thumb_format')) {
      m.thumb_format = (['unknown', 'jpeg', 'bitmap', 'bitmap16', 'layer', 'rollei', 'h265'][Number(m.thumb_format)] || 'unknown') as string
    }
    if (m?.hasOwnProperty('desc')) m.desc = String(m.desc).trim()
    if (m?.hasOwnProperty('timestamp') && m.timestamp) m.timestamp = new Date(Number(m.timestamp) * 1000)
    return m as LibRawMeta
  }

  async imageData(): Promise<LibRawImageData> {
    return (await this.runFn('imageData')) as LibRawImageData
  }

  async rawImageData(): Promise<LibRawImageData> {
    return (await this.runFn('rawImageData')) as LibRawImageData
  }

  async thumbnailData(): Promise<{ data?: Uint8Array; format?: string }> {
    return (await this.runFn('thumbnailData')) as { data?: Uint8Array; format?: string }
  }
}
