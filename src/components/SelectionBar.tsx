import { useLibrary } from '../store/library'
import { bridge } from '@/lib/bridge'
import { Button } from './ui'

export function SelectionBar() {
  const selected = useLibrary((s) => s.selected)
  const visible = useLibrary((s) => s.visible)
  const photos = useLibrary((s) => s.photos)
  const selectAll = useLibrary((s) => s.selectAll)
  const invertSelection = useLibrary((s) => s.invertSelection)
  const clearSelection = useLibrary((s) => s.clearSelection)

  const count = selected.size
  if (count < 1) return null

  const hasAll = visible.length > 0 && visible.every((index) => selected.has(index))

  async function openSelected() {
    for (const index of Array.from(selected)) {
      const photo = photos[index]
      if (photo) await bridge.shell.open(photo.path)
    }
  }

  async function revealSelected() {
    const index = Array.from(selected)[0]
    const photo = index === undefined ? undefined : photos[index]
    if (photo) await bridge.shell.reveal(photo.path)
  }

  async function binSelected() {
    const paths = Array.from(selected)
      .map((index) => photos[index]?.path)
      .filter((path): path is string => Boolean(path))
    if (paths.length) await bridge.shell.sendToBin(paths)
    clearSelection()
  }

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="flex items-center gap-2 border-b border-line bg-raised px-3 py-1.5"
    >
      <span className="num text-[12px] text-ink-2">{count} selected</span>
      <div className="mx-1 h-4 w-px bg-line" />
      <Button size="sm" variant="solid" onClick={() => (hasAll ? clearSelection() : selectAll())}>
        {hasAll ? 'Clear all' : 'Select all'}
      </Button>
      <Button size="sm" variant="solid" onClick={invertSelection}>
        Invert
      </Button>
      <Button size="sm" variant="solid" onClick={() => void openSelected()}>
        Open
      </Button>
      <Button size="sm" variant="solid" onClick={() => void revealSelected()}>
        Reveal
      </Button>
      <Button size="sm" variant="danger" onClick={() => void binSelected()}>
        Move to Recycle Bin
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={clearSelection}>
        Cancel
      </Button>
    </div>
  )
}
