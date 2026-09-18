// 左侧照片列:缩略图卡片 + 悬停移除
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PhotoEntry } from '@/hooks/useRawViewer'

interface Props {
  list: PhotoEntry[]
  currentIdx: number
  onSelect: (i: number) => void
  onRemove: (i: number) => void
}

export function ThumbColumn({ list, currentIdx, onSelect, onRemove }: Props) {
  if (list.length === 0) {
    return (
      <aside className="flex w-44 shrink-0 flex-col border-r bg-muted/40 p-2.5">
        <h3 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">已导入照片</h3>
        <div className="mt-6 text-center text-xs text-muted-foreground">尚未导入照片</div>
      </aside>
    )
  }
  return (
    <aside className="flex w-44 shrink-0 flex-col gap-2 border-r bg-muted/40 p-2.5">
      <h3 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">已导入照片</h3>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {list.map((e, i) => (
          <div key={e.file.name + i} className={cn(
            'group relative shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 transition-colors',
            i === currentIdx ? 'border-primary' : 'border-transparent hover:border-muted-foreground/40',
          )} onClick={() => onSelect(i)}>
            <img src={e.thumbUrl} alt="" className="block h-40 w-full object-contain bg-card" />
            <div className="truncate bg-black/40 px-2 py-1 text-[10px] text-white">{e.file.name}</div>
            <Button
              size="icon-xs"
              variant="ghost"
              className="absolute right-1 top-1 size-5 bg-destructive text-white opacity-0 group-hover:opacity-100"
              onClick={ev => { ev.stopPropagation(); onRemove(i) }}
            >
              <X className="size-3" />
            </Button>
          </div>
        ))}
      </div>
    </aside>
  )
}
