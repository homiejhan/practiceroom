# Practice Room

A live whiteboard for one-on-one tutoring, built on the [DeepSpace SDK](https://docs.deep.space).

**Live:** https://practiceroom.app.space

A tutor signs in and opens a room. A student opens the room's link, types a name, and is on the
board: no account. Both draw, type math and see each other's cursors. The tutor asks Claude for a
practice question, the student works it on the board, and when the tutor draws a box around the
work and presses **Check**, Claude grades what is inside the box and posts a step-by-step
explanation to the room chat.

## What it does

- **Shared whiteboard** with five tools: move around, select, type math, pen (nine colors), and
  highlighter (six neon colors). Plus undo/redo and zoom.
- **Math typing that behaves like Desmos**: `/` makes a fraction, `^` an exponent, `sqrt` a
  radical, `pi` a π. Entries are stored as LaTeX.
- **Live cursors with names**, for everyone in the room.
- **Questions on demand** (tutor only): describe a problem in words, or pick subject → unit →
  topic → question type and Claude writes a new problem of that type with different numbers. The
  answer key stays private to the tutor.
- **Check a region** (tutor only): box part of the board, and Claude grades only that part against
  the answer key.
- **Room chat** for everyone, with LaTeX rendering. Claude posts there only when the tutor checks a
  region.
- **A private Claude chat** for the tutor, which students cannot see.

## How it is built

| Need | DeepSpace primitive | Where |
| --- | --- | --- |
| Board content (ink, typed math, question cards) | `CanvasRoom` via `useCanvas`, one per room | `src/board/Board.tsx` |
| Cursors and the tutor's check box | `PresenceRoom` via `usePresenceRoom`, one per room | `src/board/Board.tsx` |
| Rooms, answer keys, question-type cache, spend counter | `RecordRoom` collections with RBAC, app scope | `src/schemas/practice-schemas.ts` |
| Room chat | `RecordRoom`, one scope per room (`room:<id>`) | `src/components/room/RoomChat.tsx` |
| Create room, generate question, grade region | Server actions | `src/actions/index.ts` |
| Claude calls | `anthropic/chat-completion` through the integration proxy | `src/server/ai.ts` |
| Tutor's private assistant | The `ai-chat` feature (`ChatPanel` + `streamDeepSpaceAgent`) | `src/components/room/TutorPanel.tsx` |
| Signing key for guest passes | The app's secrets store (`GUEST_SECRET`) | `src/server/guest.ts` |

There is no API key in the repository or in the app: every Claude call goes through DeepSpace.

### Students have no account, so the worker gives them an identity

DeepSpace rooms take identity from a verified JWT, and a socket without one is an anonymous
read-only viewer. To let a name-only student write, the worker issues its own credential when the
student joins: a pass naming one room, a random guest id and the display name, signed with HMAC
and stored in an HttpOnly cookie. Same-origin WebSocket upgrades carry cookies, so the canvas and
presence routes verify the pass and forward a `member` identity for that room only
(`src/server/realtime-routes.ts`). A pass for one room is useless in another, and a cookie the
browser edits fails the signature check.

### Who can read and write what

- **Answer keys** (`question_keys`) are created only by the worker and readable only by the tutor
  who owns them. The question text is copied onto the board; the answer and solution are not.
- **Room chat** (`room_messages`) is read-only to every client. Posts go through the worker, which
  stamps the verified author name, so nobody can post as someone else or forge a grading result.
- **Each room's chat is its own record scope**, so reading it requires knowing the room id. One
  shared collection with a public read rule would have exposed every room's chat.
- **Tutor actions** (generate, check) verify that the caller owns the room before reading a key or
  spending a paid call.

### How a check works

The tutor's browser turns the boxed rectangle into two things (`src/board/renderRegion.ts`):
a PNG of the ink, and the typed entries and question cards inside the box as data. Ink has to be
an image because handwriting can only be read from pixels. Typed math is sent as its exact LaTeX
and appears in the image only as a labelled placeholder, which is more reliable than asking a
vision model to re-read rendered math. The worker attaches the private answer keys, calls Claude,
and posts the result to the room chat.

### Who pays for AI

Question generation, grading and the tutor's assistant are billed to the app owner, so a tutor
needs no credits. Sign-in is required for all three, and every call counts against a per-user
daily allowance (`src/server/ai-usage.ts`). Reply sizes are capped because the platform reserves
credits for the largest possible reply before a call runs.

## Run it

```sh
npm install
npx deepspace auth login     # once
npx deepspace dev start      # http://localhost:5173
```

The guest-pass signing key must exist in the app's secrets store:

```sh
openssl rand -hex 32 | npx deepspace secrets set GUEST_SECRET --stdin
```

## Tests

```sh
npx deepspace test run all                                         # everything free
RUN_AI_TESTS=1 npx deepspace test run tests/room.spec.ts           # adds real Claude calls
```

`tests/room.spec.ts` drives a signed-in tutor and a name-only student in two browser contexts
against the real workers. The free test covers joining by name, ink in both directions,
highlighter, select/move/delete/undo, cursor names, typed fractions, chat, and the server
boundaries (no pass, wrong room, forged cookie, student calling a tutor action). The opt-in test
creates a question both ways, grades a boxed wrong answer, and uses the tutor's private chat.

## Tradeoffs and limits

- **A room link is the key to the room.** Anyone with the link can join by name and write on the
  board. That is the point for a tutoring link, but it means the id must stay unguessable (the
  worker mints it) and a room is not private from someone the link is forwarded to.
- **The board has no per-shape permissions.** `CanvasRoom` gives every member the same write
  access, so a student can move or delete anyone's ink. Question cards are locked to the tutor in
  the UI only.
- **Ink appears to others when a stroke ends**, not while it is being drawn.
- **Edits are last-write-wins per shape**, which is how `CanvasRoom` merges. Two people dragging
  the same stroke at once will see one of them win.
- **Grading depends on reading handwriting from an image.** Typed answers are exact; messy ink can
  be misread, and the prompt asks Claude to say so when it is unsure.
- **Deleting a room removes its record** (the link stops working) but does not clear that room's
  board or chat storage.
- **One integration, used three ways.** Only `anthropic/chat-completion` is on the main path
  (question types, question writing, vision grading). Email and PDF export were left out because
  the session happens live on the board; a recap email with a worksheet PDF is the next thing I
  would add.

## Where the subject list comes from

`src/catalog/subjects.json` is generated from the curriculum maps in my own tutoring project
(nine subjects, each topic with a one-line scope). Question types are not stored there: Claude
generates them the first time any tutor opens a topic, and they are cached in `question_types`
for everyone after that.
