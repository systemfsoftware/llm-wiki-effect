import { Button } from '@/components/ui/button'
import { getRecentProjects, removeFromRecentProjects } from '@/lib/project-store'
import type { WikiProject } from '@/types/wiki'
import { Clock, FolderOpen, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface WelcomeScreenProps {
  onCreateProject: () => void
  onOpenProject: () => void
  onSelectProject: (project: WikiProject) => void
}

export function WelcomeScreen({
  onCreateProject,
  onOpenProject,
  onSelectProject,
}: WelcomeScreenProps) {
  const { t } = useTranslation()
  const [recentProjects, setRecentProjects] = useState<WikiProject[]>([])

  useEffect(() => {
    getRecentProjects().then(setRecentProjects).catch(() => {})
  }, [])

  async function handleRemoveRecent(e: React.MouseEvent, path: string) {
    e.stopPropagation()
    await removeFromRecentProjects(path)
    const updated = await getRecentProjects()
    setRecentProjects(updated)
  }

  return (
    <div className='flex h-full items-center justify-center bg-background'>
      <div className='flex flex-col items-center gap-8 px-4'>
        <div className='text-center'>
          <h1 className='text-3xl font-bold'>{t('app.title')}</h1>
          <p className='mt-2 text-muted-foreground'>
            {t('app.subtitle')}
          </p>
        </div>

        <div className='flex gap-3'>
          <Button onClick={onCreateProject}>
            <Plus className='mr-2 h-4 w-4' />
            {t('welcome.newProject')}
          </Button>
          <Button variant='outline' onClick={onOpenProject}>
            <FolderOpen className='mr-2 h-4 w-4' />
            {t('welcome.openProject')}
          </Button>
        </div>

        {recentProjects.length > 0 && (
          <div className='w-full max-w-md'>
            <div className='mb-2 flex items-center gap-2 text-sm text-muted-foreground'>
              <Clock className='h-3.5 w-3.5' />
              {t('welcome.recentProjects')}
            </div>
            <div className='rounded-lg border'>
              {recentProjects.map((proj) => (
                <div
                  key={proj.path}
                  className='group flex w-full items-center justify-between border-b transition-colors last:border-b-0 hover:bg-accent'
                >
                  <button
                    type='button'
                    onClick={() => onSelectProject(proj)}
                    className='min-w-0 flex-1 px-4 py-3 text-left'
                  >
                    <div className='truncate text-sm font-medium'>{proj.name}</div>
                    <div className='truncate text-xs text-muted-foreground'>
                      {proj.path}
                    </div>
                  </button>
                  <button
                    type='button'
                    onClick={(e) => void handleRemoveRecent(e, proj.path)}
                    aria-label={`${t('welcome.removeRecent', 'Remove')} ${proj.name}`}
                    className='mr-4 ml-2 shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100'
                  >
                    <X className='h-3.5 w-3.5 text-muted-foreground' />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
