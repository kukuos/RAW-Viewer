// 顶部工具栏:打开/追加、导出下拉、缩放、面板切换、质量档位、主题切换
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Download, FolderOpen, ListPlus, Minus, Plus,
  Sun, Moon, BarChart3, Info, MapPin, SlidersHorizontal, Search, Image as ImageIcon,
} from 'lucide-react'
import { ENGINES } from '@/lib/rawEngine'
import { cn } from '@/lib/utils'

interface ToolbarProps {
  onOpen: () => void
  onAppend: () => void
  onExportOne: () => void
  onExportAll: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  on100: () => void
  engine: string
  onEngine: (e: string) => void
  panel: string
  onPanel: (p: string) => void
  canExport: boolean
  exporting: boolean
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export function Toolbar(p: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-background px-3 py-1.5">
      <div className="mr-1 flex items-center gap-1.5 font-semibold">
        <span className="inline-block size-2.5 rounded-[4px] bg-gradient-to-br from-red-400 to-blue-500" />
        RAW 文件查看助手
        <span className="font-normal text-muted-foreground">LibRaw-WASM</span>
      </div>

      <Button size="sm" onClick={p.onOpen}>
        <FolderOpen className="size-4" /> 打开 RAW…
      </Button>
      <Button size="sm" variant="outline" onClick={p.onAppend}>
        <ListPlus className="size-4" /> 追加照片
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={!p.canExport || p.exporting}>
            <Download className="size-4" /> 导出
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={p.onExportOne}>导出当前照片 (JPEG)</DropdownMenuItem>
          <DropdownMenuItem onClick={p.onExportAll}>导出全部照片 (ZIP 压缩包)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="h-6" />

      <Button size="sm" variant="ghost" onClick={p.onZoomIn} title="放大"><Plus className="size-4" /></Button>
      <Button size="sm" variant="ghost" onClick={p.onZoomOut} title="缩小"><Minus className="size-4" /></Button>
      <Button size="sm" variant="ghost" onClick={p.onFit}>适应</Button>
      <Button size="sm" variant="ghost" onClick={p.on100}>100%</Button>

      <Separator orientation="vertical" className="h-6" />

      <Tabs value={p.panel} onValueChange={p.onPanel} className="h-8">
        <TabsList className="h-8">
          <TabsTrigger value="hist" title="直方图"><BarChart3 className="size-4" /><span className="hidden lg:inline">直方图</span></TabsTrigger>
          <TabsTrigger value="meta" title="信息"><Info className="size-4" /><span className="hidden lg:inline">信息</span></TabsTrigger>
          <TabsTrigger value="map" title="位置"><MapPin className="size-4" /><span className="hidden lg:inline">位置</span></TabsTrigger>
          <TabsTrigger value="adj" title="调整"><SlidersHorizontal className="size-4" /><span className="hidden lg:inline">调整</span></TabsTrigger>
          <TabsTrigger value="zoom" title="缩放平移"><Search className="size-4" /><span className="hidden lg:inline">放大查看</span></TabsTrigger>
        </TabsList>
      </Tabs>

      <Button size="sm" variant="ghost" title="提取内嵌预览图" onClick={() => {}}>
        <ImageIcon className="size-4" /><span className="hidden lg:inline">预览图</span>
      </Button>

      <Button size="icon-sm" variant="ghost" onClick={p.onToggleTheme} title="切换白天 / 黑夜外观">
        {p.theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>

      <div className="ml-auto flex items-center gap-1">
        {Object.entries(ENGINES).map(([k, e]) => (
          <Button
            key={k}
            size="sm"
            variant={p.engine === k ? 'default' : 'ghost'}
            className={cn('h-7 px-2 text-xs', p.engine === k && 'font-semibold')}
            onClick={() => p.onEngine(k)}
          >
            {e.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
