import type { ReviewItem } from '@/stores/review-store'

const ACTIVE_RESEARCH_STATUSES = new Set([
  'queued',
  'searching',
  'synthesizing',
  'saving',
])

export function reviewSupportsResearch(item: ReviewItem): boolean {
  return item.type === 'suggestion' || item.type === 'missing-page'
}

export function reviewResearchTopic(item: ReviewItem): string {
  return item.title.trim() || item.description.split('\n')[0]?.trim() || ''
}

export function selectedResearchReviews(
  items: ReviewItem[],
  selectedIds: ReadonlySet<string>,
  researchTasks: Array<{ sourceReviewId?: string; status: string }>,
): ReviewItem[] {
  const activeReviewIds = new Set<string>()
  for (const task of researchTasks) {
    if (task.sourceReviewId && ACTIVE_RESEARCH_STATUSES.has(task.status)) {
      activeReviewIds.add(task.sourceReviewId)
    }
  }
  return items.filter((item) =>
    !item.resolved &&
    selectedIds.has(item.id) &&
    reviewSupportsResearch(item) &&
    !activeReviewIds.has(item.id)
  )
}
