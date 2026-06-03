# Collaborative Todo (React)

A collaborative todo app where **every todo item's text is a CRDT** — two users can edit the same todo simultaneously and both changes merge at the character level.

Built with React, Yjs, and `useText` — kyneta's hook for binding a CRDT text field to an `<input>` or `<textarea>`.

## Quick Start

```bash
# From the kyneta root
pnpm install

# Start the server (Vite HMR + WebSocket sync, single process)
cd examples/todo-react
pnpm run dev
```

Open http://localhost:5173 in two browser tabs. Add a todo in one tab, then **edit its text in both tabs at the same time** — edits merge without conflict.

> **Note:** This example uses port 5173 (Vite's default), the same port as the Cast todo. Stop one before starting the other.

## What Makes This Different

Most todo apps use `Schema.string()` for the todo text — last-writer-wins. If two users edit the same todo simultaneously, one edit is lost.

This example uses `Schema.text()` — a character-level CRDT. Each todo's text field is bound to an `<input>` via `useText`, which handles:

- **Local edits** → diffed against the CRDT and applied as insert/delete operations
- **Remote edits** → surgically patched into the `<input>` via `setRangeText`, preserving the local user's cursor position
- **Concurrent edits** → merged by the CRDT engine (Yjs) at the character level
- **IME composition** → safely deferred until the composition commits
- **Echo suppression** → local mutations don't bounce back through the changefeed

```tsx
// The key pattern: useText returns a ref callback for the <input>
function TodoItem({ todoRef }) {
  const textInputRef = useText(todoRef.text)
  return <input ref={textInputRef} type="text" />
}
```

## What's Here

```
todo-react/
├── index.html         # HTML shell
├── vite.config.ts     # @vitejs/plugin-react
├── src/
│   ├── schema.ts      # Schema.text() + yjs.bind
│   ├── app.tsx        # React components with useText
│   ├── main.tsx       # Client (ExchangeProvider + mount)
│   └── server.ts      # Server (Vite middleware + Exchange + ws)
├── style.css
├── package.json
├── tsconfig.json
└── README.md
```

## The Schema

```ts
import { Schema } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"

export const TodoItemSchema = Schema.struct({
  id: Schema.string(),      // ← stable identity (keys the list, never the index)
  text: Schema.text(),      // ← CRDT text, not Schema.string()
  done: Schema.boolean(),
})

export const TodoSchema = Schema.struct({
  todos: Schema.list(TodoItemSchema),
})

export const TodoDoc = yjs.bind(TodoSchema)
```

## The Component

```tsx
import { useDocument, useValue, useText } from "@kyneta/react"
import { remove } from "@kyneta/schema"
import { useState } from "react"

// Self-contained: the row owns its done/text/remove through `todoRef`.
function TodoItem({ todoRef, autoFocus, onEnter }) {
  const done = useValue(todoRef.done)

  return (
    <li>
      <input
        type="checkbox"
        checked={done}
        onChange={() => todoRef.done.set(!done)}
      />
      <input
        ref={useText(todoRef.text)}
        type="text"
        autoFocus={autoFocus}
        onKeyDown={e => e.key === "Enter" && onEnter()}
      />
      <button onClick={() => remove(todoRef)}>×</button>
    </li>
  )
}

function App() {
  const doc = useDocument("todos", TodoDoc)
  const todos = useValue(doc.todos)        // reactive snapshot (add/remove + empty-state)
  const [newId, setNewId] = useState(null) // id of the row to autofocus

  const addTodo = () => {
    const id = crypto.randomUUID()
    setNewId(id)
    doc.todos.push({ id, text: "", done: false })
  }

  // Map the child refs (stable identity) and key by the todo's stable id.
  return (
    <ul>
      {[...doc.todos].map(todoRef => (
        <TodoItem
          key={todoRef.id()}
          todoRef={todoRef}
          autoFocus={todoRef.id() === newId}
          onEnter={addTodo}
        />
      ))}
    </ul>
  )
}
```

Key details:

- `useText(todoRef.text)` returns a React ref callback — pass it as `ref` on the `<input>`
- The `<input>` is **uncontrolled** — `useText` manages its value imperatively, not through React state
- Rows are keyed by `todo.id` (a stable identity) and mapped from the child refs (`[...doc.todos]`) — **never `key={index}`**, which is unsafe for a collaborative list where a peer's concurrent insert/remove shifts positions and would mis-associate focus/cursor with the wrong row
- Each row is self-contained: it toggles via `todoRef.done.set(...)` and removes itself via the **`remove(todoRef)`** facade — no index threading
- Adding a todo pushes `{ id, text: "", done: false }`; the new row **autofocuses** so you can type immediately, and **Enter** adds the next one

## Architecture

```
Browser Tab A                          Browser Tab B
┌─────────────────────┐                ┌─────────────────────┐
│  <input>            │                │  <input>            │
│    ↕ useText()      │                │    ↕ useText()      │
│  Yjs Y.Text         │                │  Yjs Y.Text         │
│    ↕ changefeed     │                │    ↕ changefeed     │
│  Exchange           │                │  Exchange           │
│    ↕ WebSocket      │                │    ↕ WebSocket      │
└─────────┬───────────┘                └─────────┬───────────┘
          │                                      │
          └──────────┐    ┌──────────────────────┘
                     ↓    ↓
              ┌──────────────────┐
              │  Server Exchange │
              │  (sync hub)     │
              └──────────────────┘
```

When Alice types in Tab A:
1. `input` event fires → `diffText` computes the delta → `batch(ref, fn, { source: ownToken })` applies it to Yjs. `ownToken` is an identity-typed `Symbol` minted per `attach()` call.
2. Yjs changefeed fires with the same `source` identity → `attach()` skips it (echo suppression via `cs.source === ownToken`)
3. Exchange sends the Yjs update to the server via WebSocket
4. Server relays to Tab B's Exchange
5. Tab B's Yjs applies the remote update → changefeed fires; substrate replay path drops `source`, so Tab B's `attach()` sees `cs.source === undefined`
6. `attach()` applies surgical `setRangeText` patches → Bob's cursor stays in place

## What Changed From `Schema.string()`

| Concern | `Schema.string()` (LWW) | `Schema.text()` (CRDT) |
|---------|--------------------------|------------------------|
| **Concurrent edits** | Last write wins — one edit is lost | Character-level merge — both edits preserved |
| **UI binding** | Controlled input with `value` + `onChange` | Uncontrolled input with `useText` ref callback |
| **Re-renders** | Every keystroke triggers React re-render | Zero re-renders — `useText` is imperative |
| **Cursor** | React re-render can reset cursor position | Cursor preserved through remote edits via `transformIndex` |
| **IME** | Must handle carefully in controlled inputs | Built-in composition handling in `useText` |

## The One-Line Substrate Swap

This example uses Yjs:

```ts
import { yjs } from "@kyneta/yjs-schema"
export const TodoDoc = yjs.bind(TodoSchema)
```

Swap to Loro:

```ts
import { loro } from "@kyneta/loro-schema"
export const TodoDoc = loro.bind(TodoSchema)
```

Same schema. Same `useText`. Same sync protocol. The Exchange doesn't know or care which CRDT engine is underneath.