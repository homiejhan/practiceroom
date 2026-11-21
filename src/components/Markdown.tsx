/**
 * Markdown with LaTeX, used for question cards, the room chat and answer keys.
 * react-markdown never renders raw HTML, so chat text from other people is
 * safe to pass straight in. Math is typeset with KaTeX.
 */

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { cn } from '@/lib/utils'

// remark-breaks keeps single line breaks, which grading results rely on.
const remarkPlugins = [remarkGfm, remarkBreaks, remarkMath]
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: false }],
]

export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {children}
      </ReactMarkdown>
    </div>
  )
})
