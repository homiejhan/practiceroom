/**
 * Markdown with LaTeX, used for question cards, the room chat and answer keys.
 * react-markdown never renders raw HTML, so chat text from other people is
 * safe to pass straight in. Math is typeset with KaTeX.
 *
 * `[graph]` and `[figure]` blocks in the text are drawn in place (see
 * `visuals/`); tables are ordinary Markdown pipe tables.
 */

import { Fragment, memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { cn } from '@/lib/utils'
import { hasVisuals, normalizeTables, splitVisuals } from '@/visuals'
import { Visual } from './Visual'

// remark-breaks keeps single line breaks, which grading results rely on.
const remarkPlugins = [remarkGfm, remarkBreaks, remarkMath]
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: false }],
]

function Text({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
      {normalizeTables(children)}
    </ReactMarkdown>
  )
}

/**
 * Text with its visuals drawn. Blocks separated only by blank lines share a
 * row, which is how "which graph shows...?" choices sit side by side.
 */
export function WithVisuals({
  children,
  renderText,
}: {
  children: string
  renderText: (text: string) => ReactNode
}) {
  const segments = useMemo(() => splitVisuals(children), [children])
  const blocks: ReactNode[] = []
  let row: ReactNode[] = []
  const flushRow = () => {
    if (row.length) {
      blocks.push(
        <div key={`row-${blocks.length}`} className="visual-row">
          {row}
        </div>,
      )
    }
    row = []
  }
  segments.forEach((segment, index) => {
    if (segment.kind === 'text') {
      flushRow()
      blocks.push(<Fragment key={index}>{renderText(segment.text)}</Fragment>)
    } else {
      row.push(<Visual key={index} kind={segment.kind} source={segment.source} />)
    }
  })
  flushRow()
  return <>{blocks}</>
}

export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={cn('md', className)}>
      {hasVisuals(children) ? (
        <WithVisuals renderText={(text) => <Text>{text}</Text>}>{children}</WithVisuals>
      ) : (
        <Text>{children}</Text>
      )}
    </div>
  )
})
