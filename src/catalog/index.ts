/**
 * Subject → unit → topic catalog for the question browser.
 *
 * subjects.json is generated from the curriculum maps in my TutorAssist
 * project (9 subjects, ~800 topic entries, each with a one-line scope
 * summary). Question *types* are not in the catalog: they are generated per
 * topic by Claude on first use and cached in the `question_types` collection.
 */

import subjects from './subjects.json'

export interface CatalogTopic {
  id: string
  title: string
  summary: string
}

export interface CatalogUnit {
  title: string
  topics: CatalogTopic[]
}

export interface CatalogSubject {
  id: string
  name: string
  units: CatalogUnit[]
}

export const CATALOG = subjects as CatalogSubject[]

export interface TopicLocation {
  subject: CatalogSubject
  unit: CatalogUnit
  topic: CatalogTopic
}

/**
 * Find a topic. A topic id can appear under more than one subject (SAT Math
 * and Calculus BC reuse other courses' topics), so the subject id narrows it.
 */
export function findTopic(topicId: string, subjectId?: string): TopicLocation | null {
  for (const subject of CATALOG) {
    if (subjectId && subject.id !== subjectId) continue
    for (const unit of subject.units) {
      const topic = unit.topics.find((t) => t.id === topicId)
      if (topic) return { subject, unit, topic }
    }
  }
  return null
}
