# Practice Room

A live whiteboard for one-on-one tutoring, built on the [DeepSpace SDK](https://docs.deep.space).

**Live:** https://practiceroom.app.space

A tutor signs in and opens a room. A student opens the room's link, types a name, and is on the
board: no account. Both draw, type math and see each other's cursors. The tutor asks Claude for a
practice question, the student works it on the board, and when the tutor draws a box around the
work and presses **Check**, Claude grades what is inside the box and posts a step-by-step
explanation to the room chat.

## What it does

- **Shared whiteboard** with six tools: move around, select, type math, pen (nine colors),
  highlighter (six neon colors) and eraser. The pen, highlighter and eraser each have an adjustable
  width, remembered on your device. Plus undo/redo and zoom, including a two-finger pinch on a
  tablet.
- **Pictures** (tutor only): put a screenshot or a photo of a homework problem on the board by
  picking a file, pasting it, or dropping it in. It sits under the ink, so both people can write
  on it, and it is part of what Claude sees when the tutor checks a region.
- **Stylus hardware**: a pen's eraser end erases ink and its side button selects, under whichever
  tool is active. Flip the pen back over and it carries on with that tool.
- **Math typing that behaves like Desmos**: `/` makes a fraction, `^` an exponent, `sqrt` a
  radical, `pi` a π. Entries are stored as LaTeX.
- **Live cursors with names**, for everyone in the room.
- **Questions on demand** (tutor only): describe a problem in words, or pick subject → unit →
  topic → question type and Claude writes a new problem of that type with different numbers. The
  answer key stays private to the tutor.
- **Graphs, geometry figures and tables**: a question, its answer key and Claude's explanations
  can include a coordinate-plane graph, a to-scale geometry figure or a table to fill in. They are
  drawn on the board, in the chat and in the worksheet PDF.
- **Check a region** (tutor only): box part of the board, and Claude grades only that part against
  the answer key.
- **Room chat** for everyone, with LaTeX rendering. Claude posts there only when the tutor checks a
  region.
- **A private Claude chat** for the tutor, which students cannot see.
- **Send the session home** (tutor only): the room's questions typeset as a printable PDF
  worksheet, with or without the worked solutions, and a recap email that links to it.

## How it is built

| Need | DeepSpace primitive | Where |
| --- | --- | --- |
| Board content (ink, typed math, question cards) | `CanvasRoom` via `useCanvas`, one per room | `src/board/Board.tsx` |
| Cursors and the tutor's check box | `PresenceRoom` via `usePresenceRoom`, one per room | `src/board/Board.tsx` |
| Rooms, answer keys, question-type cache, spend counter | `RecordRoom` collections with RBAC, app scope | `src/schemas/practice-schemas.ts` |
| Room chat | `RecordRoom`, one scope per room (`room:<id>`) | `src/components/room/RoomChat.tsx` |
| Create room, generate question, grade region | Server actions | `src/actions/index.ts` |
| Claude calls | `anthropic/chat-completion` through the integration proxy | `src/server/ai.ts` |
| Worksheet PDF | `latex-compiler/compile` integration, stored with `appFiles` | `src/server/worksheet.ts` |
| Recap email | `email/send` integration | `src/actions/index.ts` |
| Graphs, figures and tables | None: a parser and layout of my own, drawn as SVG and as TikZ | `src/visuals/` |
| Pictures on the board | `appFiles` (app scope); the address is a `CanvasRoom` shape | `src/board/imageUpload.ts`, `src/actions/index.ts` |
| Tutor's private assistant | The `ai-chat` feature (`ChatPanel` + `streamDeepSpaceAgent`) | `src/components/room/TutorPanel.tsx` |
| Signing key for guest passes | The app's secrets store (`GUEST_SECRET`) | `src/server/guest.ts` |

There is no API key in the repository or in the app: Claude, the LaTeX compiler and email all go
through DeepSpace's integration proxy.

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
- **Tutor actions** (generate, check, add a picture) verify that the caller owns the room before
  reading a key, spending a paid call or storing a file.
- **Pictures** are scaled down and re-encoded in the tutor's browser, so only plain PNG or JPEG
  bytes reach storage, and each tutor has a daily allowance. Shape data is written by anyone in
  the room, so a picture is only ever shown if its address is one of this app's own files
  (`boardImageSrc` in `src/board/types.ts`); a crafted shape cannot make other people's browsers
  fetch an outside URL.

### How a check works

The tutor's browser turns the boxed rectangle into two things (`src/board/renderRegion.ts`):
an image of the ink, and the typed entries and question cards inside the box as data. Ink has to
be an image because handwriting can only be read from pixels. A picture the tutor placed is drawn
into that image under the ink, so a photographed problem and the answer written on it are graded
together. Typed math is sent as its exact LaTeX
and appears in the image only as a labelled placeholder, which is more reliable than asking a
vision model to re-read rendered math. The worker attaches the private answer keys, calls Claude,
and posts the result to the room chat.

### Graphs, figures and tables

Claude does not draw. It writes a short block of text, and the app draws it:

```
[graph]                          [figure]
x: -5 to 5                       triangle ABC AB=8 angle A=50 angle B=60
y = 2x - 3 [label: $f$]          side AB 8 cm
y = x + 3 for -3 <= x < 0        angle C $x^\circ$
point A (1, -1)                  [/figure]
[/graph]
```

The block format is the one my TutorAssist project's worksheet generator uses, so a problem
written for either works in both. Tables are ordinary Markdown pipe tables.

- **One layout, two outputs.** A block is parsed and laid out once into a scene: a flat list of
  paths, dots and labels in pixels (`src/visuals/scene.ts`). The browser draws the scene as SVG
  with KaTeX labels (`src/components/Visual.tsx`); the worksheet writes the same scene as TikZ
  (`src/visuals/tikz.ts`). Clipping, arrowheads and label positions are decided before either
  one sees it, so the screen and the PDF match.
- **Figures are computed, not sketched.** A triangle given as two angles and a side is solved
  with the laws of sines and cosines and scaled uniformly, so the picture is true to its numbers.
- **Expressions are parsed, never evaluated as code.** `src/visuals/expr.ts` tokenises `2x - 3`
  or `\frac{1}{2}x` and builds a closure. Chat messages go through the same renderer, so this
  runs on text other people typed.
- **Claude's blocks are checked on the server.** A line the parser cannot read goes back to
  Claude once with the parser's own message. If it is still wrong, the rest of the picture is
  drawn and the card says part of it is missing.
- **The prompt cannot drift from the parser.** A unit test runs every example in the
  instructions Claude is given through the parser and fails if one of them would not draw.

### The worksheet and the recap email

Questions are stored as Markdown with `$...$` math, which is what the board and chat render. A
printed worksheet needs real LaTeX, so `src/server/worksheet.ts` converts the small Markdown
subset Claude is told to write and escapes everything else, then `latex-compiler/compile` typesets
it. The PDF is stored in the app's files under a random key and the email links to it, because
`email/send` has no attachments. The email itself is a fixed template with the question titles;
the math stays in the PDF, where it is typeset properly. Replies go to the tutor.

### Who pays

Question generation, grading, the tutor's assistant, worksheets and recap emails are billed to the
app owner, so a tutor needs no credits. Sign-in is required for all of them, and every call counts
against a per-user daily allowance (`src/server/ai-usage.ts`). Recap emails have their own smaller
allowance (10 a day), because they go to an address the tutor types. Reply sizes are capped
because the platform reserves credits for the largest possible reply before a call runs.

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
boundaries (no pass, wrong room, forged cookie, student calling a tutor action). A second free
test sends the Pointer Events a stylus would (eraser end, side button) and checks erasing, undo,
selecting and moving on both screens. A third covers the eraser tool, the width sliders, and
two-finger zoom, the last with real touch input through the browser as well as scripted events. A
fourth uploads and pastes a picture, checks that a student with no account sees it, resizes it,
writes on it, and confirms the grading capture contains it. A fifth posts a graph, a figure and a
table as a chat message and checks that both screens draw them. The opt-in tests create a question both ways,
grade a boxed wrong answer, use the tutor's private chat, make a worksheet PDF and open it without
an account, send a recap to the mail provider's test inbox, and ask Claude for a geometry question
and a table-and-graph question to confirm it writes blocks the app can draw.
`src/visuals/visuals.test.ts` unit-tests the expression parser, graphs, figures and TikZ output;
`src/server/worksheet.test.ts` the Markdown-to-LaTeX conversion.

## Tradeoffs and limits

- **A room link is the key to the room.** Anyone with the link can join by name and write on the
  board. That is the point for a tutoring link, but it means the id must stay unguessable (the
  worker mints it) and a room is not private from someone the link is forwarded to.
- **The board has no per-shape permissions.** `CanvasRoom` gives every member the same write
  access, so a student can move or delete anyone's ink. Question cards are locked to the tutor in
  the UI only.
- **Ink appears to others when a stroke ends**, not while it is being drawn.
- **Only the tutor can add, move or remove a picture.** Moving and removing are rules of the
  interface, like question cards. A picture's address is public to anyone who has it, as a
  worksheet link is, and removing it from the board does not delete the stored file.
- **Touch is one finger to draw, two to zoom and pan.** There is no setting to make one finger
  pan while a stylus draws.
- **Pen controls are the ones a browser can see.** The eraser end and the side button arrive as
  Pointer Events (`src/board/penInput.ts`). A Surface pen's top-button click and an Apple Pencil's
  double-tap go to the operating system, not to web pages. The eraser removes whole strokes, and
  only ink: typed math and question cards are removed with Select and Delete.
- **Edits are last-write-wins per shape**, which is how `CanvasRoom` merges. Two people dragging
  the same stroke at once will see one of them win.
- **Grading depends on reading handwriting from an image.** Typed answers are exact; messy ink can
  be misread, and the prompt asks Claude to say so when it is unsure.
- **Visuals cover the common cases, not everything.** Graphs of functions and inequalities,
  points and simple shapes on a plane, and plane geometry figures with their marks. There are no
  3-D graphs, shaded regions between curves, or solids of revolution, which the TutorAssist
  generator has. Labels are placed by simple rules and can overlap in a crowded picture.
- **Anyone in the room can post a graph or figure in chat** by typing a block. That is the same
  renderer the question cards use, not a separate permission.
- **Deleting a room removes its record** (the link stops working) but does not clear that room's
  board or chat storage.
- **A worksheet link is public to anyone who has it.** App-scope files are world-readable, which
  is what lets a student open the PDF from an email with no account. The key is random, but a
  worksheet made with the answers included should only be sent to someone who should see them.
- **A recap can be sent to any address the tutor types.** The message is a fixed template and
  sends are capped per tutor per day, so the app is not a general way to email strangers, but
  there is no confirmation step from the recipient.
- **The recap does not include Claude's grading results**, only the questions and, optionally,
  the worked solutions from the answer keys.

## Where the subject list comes from

`src/catalog/subjects.json` is generated from the curriculum maps in my own tutoring project
(nine subjects, each topic with a one-line scope). Question types are not stored there: Claude
generates them the first time any tutor opens a topic, and they are cached in `question_types`
for everyone after that.
