import { ArrowClockwise, CaretRight, PaperPlaneRight, Sparkle } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { bridge } from '@/lib/bridge'
import { useLibrary } from '@/store/library'
import { Button, IconButton } from './ui'

/**
 * The local-AI dock. It sits to the right of the grid, remembers its width, and
 * is honest when no model is installed rather than pretending a reply is coming.
 */
export function AiDock() {
  const expanded = useLibrary((s) => s.aiDockExpanded)
  const width = useLibrary((s) => s.aiDockWidth)
  const messages = useLibrary((s) => s.aiMessages)
  const thinking = useLibrary((s) => s.aiThinking)
  const modelReady = useLibrary((s) => s.aiModelReady)
  const { toggleAi, setAiDockExpanded, setAiDockWidth, sendAiMessage } = useLibrary()

  const [draft, setDraft] = useState('')
  const [reloading, setReloading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, thinking])

  const reload = async (): Promise<void> => {
    setReloading(true)
    try {
      const ai = await bridge.ai.init()
      useLibrary.setState({ aiModelReady: ai.ready })
    } finally {
      setReloading(false)
    }
  }

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || !modelReady || thinking) return
    setDraft('')
    void sendAiMessage(text)
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = useLibrary.getState().aiDockWidth
    const onMove = (move: PointerEvent): void => {
      const next = Math.min(720, Math.max(240, Math.round(startWidth + (startX - move.clientX))))
      useLibrary.setState({ aiDockWidth: next })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setAiDockWidth(useLibrary.getState().aiDockWidth)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setAiDockExpanded(true)}
        title="Open AI"
        aria-label="Open AI"
        className="flex h-full w-9 shrink-0 flex-col items-center gap-2 border-l border-line bg-surface py-3 text-ink-3 transition-colors duration-150 hover:text-ink"
      >
        <Sparkle size={15} weight="regular" />
      </button>
    )
  }

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-surface"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
        className="absolute -left-0.5 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors duration-150 hover:bg-accent"
      />

      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Sparkle size={14} weight="fill" className="text-accent-text" />
        <span className="text-[12px] font-semibold">AI assistant</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
          {modelReady ? 'Local model ready' : 'No local model'}
        </span>
        <IconButton label="Collapse AI" onClick={toggleAi}>
          <CaretRight size={15} weight="regular" />
        </IconButton>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-2 text-[12px] leading-relaxed text-ink-3">
            <p>
              Ask about the pictures you have selected, or have it name and group them. Everything
              runs on this machine.
            </p>
            {!modelReady ? (
              <div className="rounded-[8px] border border-line bg-raised p-3">
                <p className="text-ink-2">No local model was found.</p>
                <p className="mt-1">
                  Add a <span className="num">.gguf</span> model to the bundled models folder, then
                  reload.
                </p>
                <Button size="sm" variant="solid" className="mt-2" onClick={() => void reload()}>
                  <ArrowClockwise size={13} weight="regular" />
                  {reloading ? 'Checking…' : 'Reload'}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {messages.map((message, index) => {
              // An assistant bubble with no text yet is the streaming placeholder;
              // the Thinking row below already says so.
              if (message.role === 'assistant' && message.content === '' && thinking) return null
              return (
                <div
                  key={index}
                  className={
                    message.role === 'user'
                      ? 'ml-6 rounded-[8px] bg-tint px-3 py-2 text-[12px] leading-relaxed text-ink'
                      : 'mr-6 whitespace-pre-wrap rounded-[8px] border border-line px-3 py-2 text-[12px] leading-relaxed text-ink-2'
                  }
                >
                  {message.content}
                </div>
              )
            })}
            {thinking ? (
              <div className="mr-6 rounded-[8px] border border-line px-3 py-2 text-[12px] text-ink-3">
                Thinking…
              </div>
            ) : null}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-line p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            rows={2}
            disabled={!modelReady || thinking}
            placeholder={modelReady ? 'Ask about your pictures…' : 'Add a model to chat'}
            aria-label="Message the AI assistant"
            className="min-h-[44px] flex-1 resize-none rounded-[8px] border border-line bg-raised px-2.5 py-2 text-[12px] text-ink placeholder:text-ink-3 transition-colors duration-150 focus:border-line-strong focus:outline-none disabled:opacity-50"
          />
          <Button
            size="sm"
            variant="accent"
            className="mb-0.5 px-2"
            disabled={!modelReady || thinking || draft.trim() === ''}
            onClick={submit}
          >
            <PaperPlaneRight size={14} weight="regular" />
          </Button>
        </div>
      </footer>
    </aside>
  )
}
