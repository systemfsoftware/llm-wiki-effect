import { ErrorBoundary } from '@/components/error-boundary'
import { refreshProjectFileTree } from '@/lib/project-file-tree-refresh'
import { useResearchStore } from '@/stores/research-store'
import { useWikiStore } from '@/stores/wiki-store'
import { PanelLeftOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityPanel } from './activity-panel'
import { getAppLayoutVisibility } from './app-layout-visibility'
import { ContentArea } from './content-area'
import { IconSidebar } from './icon-sidebar'
import { ResearchPanel } from './research-panel'
import { SidebarPanel } from './sidebar-panel'
import { UpdateBanner } from './update-banner'

const LEFT_PANEL_COLLAPSED_KEY = 'llm-wiki:left-panel-collapsed'

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const activeView = useWikiStore((s) => s.activeView)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const [leftWidth, setLeftWidth] = useState(220)
  const [rightWidth, setRightWidth] = useState(400)
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem(LEFT_PANEL_COLLAPSED_KEY) === 'true',
  )
  const isDraggingLeft = useRef(false)
  const isDraggingRight = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const loadFileTree = useCallback(async () => {
    if (!project) return
    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      clearDisplayTreeFirst: true,
    })
  }, [project])

  useEffect(() => {
    void loadFileTree()
  }, [loadFileTree])

  const startDrag = useCallback(
    (side: 'left' | 'right') => (e: React.MouseEvent) => {
      e.preventDefault()
      if (side === 'left') isDraggingLeft.current = true
      else isDraggingRight.current = true
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.body.dataset.panelResizing = 'true'

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!containerRef.current) return
        const rect = containerRef.current.getBoundingClientRect()

        if (isDraggingLeft.current) {
          const newWidth = moveEvent.clientX - rect.left
          // Hard cap: 150 to 400px
          setLeftWidth(Math.max(150, Math.min(400, newWidth)))
        }
        if (isDraggingRight.current) {
          const newWidth = rect.right - moveEvent.clientX
          // Hard cap: 250 to 50% of container
          setRightWidth(Math.max(250, Math.min(rect.width * 0.5, newWidth)))
        }
      }

      const handleMouseUp = () => {
        isDraggingLeft.current = false
        isDraggingRight.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        delete document.body.dataset.panelResizing
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [],
  )

  const nudgeLeftWidth = useCallback((delta: number) => {
    setLeftWidth((width) => Math.max(150, Math.min(400, width + delta)))
  }, [])

  const nudgeRightWidth = useCallback((delta: number) => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width
    setRightWidth((width) => {
      const maxWidth = containerWidth === undefined ? Infinity : containerWidth * 0.5
      return Math.max(250, Math.min(maxWidth, width + delta))
    })
  }, [])

  // Settings and Chat are standalone views. Hide the project file tree,
  // activity strip, and optional right research panel there so those
  // screens use the whole work area.
  const { showLeftPanel, hasRightPanel } = getAppLayoutVisibility(activeView, researchPanelOpen)
  const toggleLeftPanel = () => {
    setLeftCollapsed((value) => {
      const next = !value
      localStorage.setItem(LEFT_PANEL_COLLAPSED_KEY, String(next))
      return next
    })
  }

  return (
    // Outer column layout: full-width update banner on top (when an
    // update is available AND not dismissed for this version), the
    // existing IconSidebar + content row below. Banner is shrink-0
    // so it doesn't compress the work area; main row is flex-1 so
    // it fills the rest of the viewport.
    <div className='flex h-full flex-col bg-background text-foreground'>
      <UpdateBanner />
      <div className='flex min-h-0 flex-1'>
        <IconSidebar onSwitchProject={onSwitchProject} />
        <div ref={containerRef} className='relative flex min-w-0 flex-1 overflow-hidden'>
          {showLeftPanel && !leftCollapsed && (
            <>
              {/* Left: File tree + Activity */}
              <div
                className='flex shrink-0 flex-col overflow-hidden border-r'
                style={{ width: leftWidth }}
              >
                <div className='flex-1 overflow-hidden'>
                  <SidebarPanel onCollapse={toggleLeftPanel} />
                </div>
                <ActivityPanel />
              </div>
              <button
                type='button'
                aria-label={t('layout.resizeSidebar', 'Resize sidebar')}
                className='w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40'
                onMouseDown={startDrag('left')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') nudgeLeftWidth(-16)
                  else if (e.key === 'ArrowRight') nudgeLeftWidth(16)
                }}
              />
            </>
          )}

          {showLeftPanel && leftCollapsed && (
            <div className='flex w-9 shrink-0 justify-center border-r bg-muted/20 pt-2'>
              <button
                type='button'
                onClick={toggleLeftPanel}
                className='flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
                title={t('layout.showSidebar', 'Show sidebar')}
                aria-label={t('layout.showSidebar', 'Show sidebar')}
              >
                <PanelLeftOpen className='h-4 w-4' />
              </button>
            </div>
          )}

          {/* Center: Chat, wiki preview, or tool view */}
          <div className='min-w-0 flex-1 overflow-hidden'>
            <ErrorBoundary>
              <ContentArea />
            </ErrorBoundary>
          </div>

          {/* Right panels */}
          {hasRightPanel && (
            <>
              <button
                type='button'
                aria-label={t('layout.resizeResearchPanel', 'Resize research panel')}
                className='w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40'
                onMouseDown={startDrag('right')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') nudgeRightWidth(16)
                  else if (e.key === 'ArrowRight') nudgeRightWidth(-16)
                }}
              />
              <div
                className='flex shrink-0 flex-col overflow-hidden border-l'
                style={{ width: rightWidth }}
              >
                <ErrorBoundary>
                  <ResearchPanel />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
