/**
 * Tutor-only side panel: create questions (describe one, or browse
 * subject → topic → question type), read the private answer keys, and talk
 * to Claude in a chat only the tutor can see.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from 'deepspace'
import { LoaderCircle } from 'lucide-react'
import { ChatPanel } from '@/components/ChatPanel'
import { Markdown } from '@/components/Markdown'
import { Button, Label, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useToast } from '@/components/ui'
import { callAction } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { CatalogSubject } from '@/catalog'

interface QuestionType {
  name: string
  description: string
  example: string
}

interface GeneratedQuestion {
  questionId: string
  title: string
  question: string
}

interface QuestionKey {
  roomId: string
  title: string
  question: string
  answer: string
  solution: string
  source: string
}

type Difficulty = 'easier' | 'standard' | 'harder'

interface TutorPanelProps {
  roomId: string
  userId: string
  onQuestion: (question: GeneratedQuestion) => void
}

const selectClass =
  'h-9 w-full rounded-md border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring disabled:opacity-50'

const TUTOR_PROMPTS = [
  'Give me three warm-up questions on factoring quadratics.',
  'Explain completing the square for a student who finds it confusing.',
  'What mistakes do students usually make with negative exponents?',
]

export function TutorPanel({ roomId, userId, onQuestion }: TutorPanelProps) {
  // Held here so the conversation survives the panel being hidden and reshown.
  const [chatId, setChatId] = useState<string | null>(null)

  // Panels stay mounted so a half-built question or an open chat is not lost
  // when the tutor switches tabs.
  return (
    <Tabs defaultValue="create" className="flex h-full min-h-0 flex-col gap-0">
      <TabsList className="mx-3 mt-3 grid w-auto grid-cols-3">
        <TabsTrigger value="create">Questions</TabsTrigger>
        <TabsTrigger value="keys">Answer keys</TabsTrigger>
        <TabsTrigger value="claude">Ask Claude</TabsTrigger>
      </TabsList>
      <TabsContent value="create" keepMounted className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <CreateQuestion roomId={roomId} onQuestion={onQuestion} />
      </TabsContent>
      <TabsContent value="keys" keepMounted className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <AnswerKeys roomId={roomId} />
      </TabsContent>
      <TabsContent value="claude" keepMounted className="min-h-0 flex-1">
        <ChatPanel
          chatId={chatId}
          onChatCreated={setChatId}
          userId={userId}
          compact
          className="h-full"
          emptyStatePrompts={TUTOR_PROMPTS}
          header={
            <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
              Private to you. Students cannot see this conversation.
            </p>
          }
        />
      </TabsContent>
    </Tabs>
  )
}

// ---------------------------------------------------------------------------
// Create a question
// ---------------------------------------------------------------------------

function CreateQuestion({
  roomId,
  onQuestion,
}: {
  roomId: string
  onQuestion: (question: GeneratedQuestion) => void
}) {
  const [mode, setMode] = useState<'describe' | 'browse'>('describe')
  const [difficulty, setDifficulty] = useState<Difficulty>('standard')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const generate = async (params: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    const result = await callAction<GeneratedQuestion>('generateQuestion', {
      roomId,
      difficulty,
      ...params,
    })
    setBusy(false)
    if (!result.ok) {
      toast.error('No question created', result.error)
      return
    }
    onQuestion(result.data)
    toast.success('Question added to the board', result.data.title)
  }

  return (
    <div className="space-y-4 pt-3">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1" role="tablist" aria-label="How to create the question">
        {(
          [
            ['describe', 'Describe it'],
            ['browse', 'Browse topics'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              'h-8 rounded text-sm font-medium',
              mode === value ? 'bg-card shadow-[0_1px_2px_rgba(27,28,31,0.12)]' : 'text-muted-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="question-difficulty">Difficulty</Label>
        <select
          id="question-difficulty"
          className={selectClass}
          value={difficulty}
          onChange={(event) => setDifficulty(event.target.value as Difficulty)}
        >
          <option value="easier">Easier</option>
          <option value="standard">Standard</option>
          <option value="harder">Harder</option>
        </select>
      </div>

      {mode === 'describe' ? (
        <DescribeForm busy={busy} onGenerate={(prompt) => generate({ mode: 'prompt', prompt })} />
      ) : (
        <BrowseForm
          busy={busy}
          onGenerate={(subjectId, topicId, typeIndex) =>
            generate({ mode: 'type', subjectId, topicId, typeIndex })
          }
        />
      )}
    </div>
  )
}

function DescribeForm({ busy, onGenerate }: { busy: boolean; onGenerate: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState('')
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (prompt.trim().length >= 3) onGenerate(prompt.trim())
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="question-prompt">Describe the problem</Label>
        <Textarea
          id="question-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          maxLength={1500}
          placeholder="A two-step linear equation with a negative coefficient and a fraction answer"
        />
      </div>
      <Button type="submit" className="w-full" disabled={busy || prompt.trim().length < 3}>
        {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
        {busy ? 'Claude is writing it' : 'Create question'}
      </Button>
    </form>
  )
}

function BrowseForm({
  busy,
  onGenerate,
}: {
  busy: boolean
  onGenerate: (subjectId: string, topicId: string, typeIndex: number) => void
}) {
  // The catalog is ~170 KB of JSON, so it loads only when a tutor opens this tab.
  const [catalog, setCatalog] = useState<CatalogSubject[] | null>(null)
  const [subjectId, setSubjectId] = useState('')
  const [unitIndex, setUnitIndex] = useState(-1)
  const [topicId, setTopicId] = useState('')
  const [types, setTypes] = useState<QuestionType[] | null>(null)
  const [typesState, setTypesState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [typesError, setTypesError] = useState('')
  const [typeIndex, setTypeIndex] = useState(-1)

  useEffect(() => {
    let alive = true
    void import('@/catalog').then((module) => {
      if (alive) setCatalog(module.CATALOG)
    })
    return () => {
      alive = false
    }
  }, [])

  const subject = useMemo(() => catalog?.find((s) => s.id === subjectId), [catalog, subjectId])
  const unit = subject?.units[unitIndex]
  const topic = unit?.topics.find((t) => t.id === topicId)

  // Load (or generate, the first time anyone opens it) this topic's question types.
  useEffect(() => {
    setTypes(null)
    setTypeIndex(-1)
    if (!subjectId || !topicId) {
      setTypesState('idle')
      return
    }
    let alive = true
    setTypesState('loading')
    void callAction<{ types: QuestionType[] }>('listQuestionTypes', { subjectId, topicId }).then(
      (result) => {
        if (!alive) return
        if (result.ok) {
          setTypes(result.data.types)
          setTypesState('idle')
        } else {
          setTypesError(result.error)
          setTypesState('error')
        }
      },
    )
    return () => {
      alive = false
    }
  }, [subjectId, topicId])

  if (!catalog) return <p className="text-sm text-muted-foreground">Loading subjects</p>

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="browse-subject">Subject</Label>
        <select
          id="browse-subject"
          className={selectClass}
          value={subjectId}
          onChange={(event) => {
            setSubjectId(event.target.value)
            setUnitIndex(-1)
            setTopicId('')
          }}
        >
          <option value="">Choose a subject</option>
          {catalog.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="browse-unit">Unit</Label>
        <select
          id="browse-unit"
          className={selectClass}
          value={unitIndex}
          disabled={!subject}
          onChange={(event) => {
            setUnitIndex(Number(event.target.value))
            setTopicId('')
          }}
        >
          <option value={-1}>Choose a unit</option>
          {subject?.units.map((u, index) => (
            <option key={u.title} value={index}>
              {u.title}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="browse-topic">Topic</Label>
        <select
          id="browse-topic"
          className={selectClass}
          value={topicId}
          disabled={!unit}
          onChange={(event) => setTopicId(event.target.value)}
        >
          <option value="">Choose a topic</option>
          {unit?.topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        {topic && <p className="text-xs text-muted-foreground">{topic.summary}</p>}
      </div>

      {typesState === 'loading' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Finding question types for this topic
        </p>
      )}
      {typesState === 'error' && <p className="text-sm text-destructive">{typesError}</p>}

      {types && (
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium">Question type</legend>
          {types.map((type, index) => (
            <label
              key={type.name}
              className={cn(
                'block cursor-pointer rounded-md border p-2.5',
                typeIndex === index ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-input',
              )}
            >
              <span className="flex items-start gap-2">
                <input
                  type="radio"
                  name="question-type"
                  className="mt-1 accent-[var(--color-primary)]"
                  checked={typeIndex === index}
                  onChange={() => setTypeIndex(index)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{type.name}</span>
                  {type.description && (
                    <span className="block text-xs text-muted-foreground">{type.description}</span>
                  )}
                </span>
              </span>
              {typeIndex === index && (
                <span className="mt-2 block rounded bg-muted px-2.5 py-2">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Model problem
                  </span>
                  <Markdown>{type.example}</Markdown>
                </span>
              )}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Claude keeps this format, changes the numbers, and works out the new answer.
          </p>
        </fieldset>
      )}

      <Button
        type="button"
        className="w-full"
        disabled={busy || typeIndex < 0 || !types}
        onClick={() => onGenerate(subjectId, topicId, typeIndex)}
      >
        {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
        {busy ? 'Claude is writing it' : 'Create question'}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Answer keys
// ---------------------------------------------------------------------------

function AnswerKeys({ roomId }: { roomId: string }) {
  const { records, status } = useQuery<QuestionKey>('question_keys', {
    where: { roomId },
    orderBy: 'createdAt',
    orderDir: 'asc',
  })

  if (status === 'loading') return <p className="pt-3 text-sm text-muted-foreground">Loading answer keys</p>
  if (!records.length) {
    return (
      <p className="pt-3 text-sm text-muted-foreground">
        Answer keys for the questions you create appear here. Only you can see them.
      </p>
    )
  }

  return (
    <ol className="space-y-3 pt-3">
      {records.map((record, index) => (
        <li key={record.recordId} className="rounded-md border border-border bg-card p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-primary">Question {index + 1}</p>
          <p className="mb-1 text-xs text-muted-foreground">{record.data.source || record.data.title}</p>
          <Markdown>{record.data.question}</Markdown>
          <div className="mt-2 rounded bg-muted px-2.5 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Answer</span>
            <Markdown>{record.data.answer}</Markdown>
          </div>
          {record.data.solution && (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-medium text-primary">Worked solution</summary>
              <Markdown className="mt-2">{record.data.solution}</Markdown>
            </details>
          )}
        </li>
      ))}
    </ol>
  )
}
