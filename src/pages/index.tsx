/**
 * Landing page — static and prerendered (no auth call, no sockets), so it is
 * cheap to serve and readable by crawlers. The live app starts at /rooms.
 */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { APP_DISPLAY_NAME } from '../constants'
import { seo } from '../seo'

const POINTS = [
  {
    title: 'One board, everyone on it',
    body: 'Pen, highlighter and a math keyboard that types like Desmos. You see each cursor by name as the student works.',
  },
  {
    title: 'Questions when you need them',
    body: 'Describe a problem, or pick a subject, topic and question type. Claude writes a fresh version and keeps the answer key private to you.',
  },
  {
    title: 'Checked only when you ask',
    body: 'Draw a box around the work and press Check. Claude grades what is inside the box and explains each step in the room chat.',
  },
]

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
        <header className="flex h-16 items-center justify-between">
          <span className="text-sm font-semibold text-primary">{APP_DISPLAY_NAME}</span>
          <Link to="/rooms" className="text-sm font-medium hover:text-primary">
            Sign in
          </Link>
        </header>

        <main className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[1fr_minmax(0,460px)]">
          <div>
            <h1 className="max-w-xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
              Work the problem together. Check it when you are ready.
            </h1>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              {APP_DISPLAY_NAME} is a live whiteboard for one-on-one tutoring. Students join from your
              link with just their name. When they finish a problem, you box it and Claude grades it
              against your answer key.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                to="/rooms"
                className="inline-flex h-11 items-center rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Open your rooms
              </Link>
              <span className="text-sm text-muted-foreground">Tutors sign in. Students do not need an account.</span>
            </div>
          </div>

          {/* A still of the board: a question card, handwritten work, and the check box. */}
          <div
            aria-hidden="true"
            className="relative h-[340px] overflow-hidden rounded-xl border border-border bg-[#fdfdfb] shadow-[0_4px_14px_rgba(27,28,31,0.1)]"
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(27,28,31,0.16) 1px, transparent 1.4px)',
              backgroundSize: '26px 26px',
            }}
          >
            <div className="absolute left-6 top-6 w-[250px] rounded-lg border border-[#cfccc1] border-l-4 border-l-primary bg-white px-3.5 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-primary">Question 1</p>
              <p className="mt-1 text-[15px] text-[#16161a]">
                Solve for <i>x</i>: &nbsp;3<i>x</i> − 7 = 11
              </p>
            </div>
            <svg className="absolute left-0 top-0 h-full w-full" viewBox="0 0 460 340" fill="none">
              <path
                d="M52 150 q10 -14 18 0 q-10 16 -18 0 m24 -8 l12 16 m0 -16 l-12 16 m24 -12 h14 m-14 8 h14 m18 -16 q16 -4 12 8 q-2 8 -14 14 h18 m10 -24 l-6 12 q10 -6 14 2 q2 10 -12 10"
                stroke="#2563eb"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M54 206 l14 20 m0 -20 l-14 20 m30 -14 h16 m-16 9 h16 m22 -18 q4 -6 12 -4 q8 4 2 12 q10 2 6 12 q-6 8 -18 2"
                stroke="#16161a"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect x="34" y="128" width="190" height="112" rx="4" stroke="#0f6b5c" strokeWidth="2" strokeDasharray="7 5" fill="rgba(15,107,92,0.05)" />
            </svg>
            <div className="absolute left-[166px] top-[250px] rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-[0_2px_8px_rgba(27,28,31,0.18)]">
              Check
            </div>
            <div className="absolute bottom-5 right-5 w-[200px] rounded-lg border border-primary/40 bg-white px-3 py-2.5 text-[12px] leading-snug text-[#16161a]">
              <p className="font-semibold">Question 1: Incorrect</p>
              <p className="mt-1 text-[#5d6067]">Add 7 to both sides first: 3x = 18, so x = 6.</p>
            </div>
          </div>
        </main>

        <section className="grid gap-8 border-t border-border py-10 sm:grid-cols-3">
          {POINTS.map((point) => (
            <div key={point.title}>
              <h2 className="text-sm font-semibold">{point.title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{point.body}</p>
            </div>
          ))}
        </section>
      </div>
    </>
  )
}
