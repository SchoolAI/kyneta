// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — App
//
//   Collaborative todo list with real-time text editing.
//
//   Each todo's text is a CRDT text field (Schema.text()) bound to an
//   <input> via useText — two users can edit the same todo at once and
//   character-level changes merge without conflict.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useDocument, useSyncState, useValue } from "@kyneta/react"
import { useState } from "react"
import { TodoDoc } from "./schema.js"
import { TodoItem } from "./todo-item.js"

function SyncIndicator({ doc }: { doc: object }) {
  const peerStates = useSyncState(doc)
  const synced = peerStates.some(s => s.state === "synced")

  return (
    <span
      className="sync-indicator"
      title={synced ? "Connected" : "Connecting..."}
    >
      {synced ? "✅" : "⏳"}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// App — the collaborative todo list
// ─────────────────────────────────────────────────────────────────────────

export function App() {
  const doc = useDocument("todos", TodoDoc)

  // Reactive snapshot of the list — re-renders on add/remove and drives the
  // empty-state. Text edits flow through useText, not through this snapshot.
  const todos = useValue(doc.todos)

  // The id of the just-created todo, so its row can autofocus on mount.
  const [newId, setNewId] = useState<string | null>(null)

  const addTodo = () => {
    const id = crypto.randomUUID()
    setNewId(id)
    doc.todos.push({ id, text: "", done: false })
  }

  return (
    <div className="app">
      <h1>
        Collaborative Todos <SyncIndicator doc={doc} />
      </h1>

      <div className="add-bar">
        <button type="button" onClick={addTodo}>
          + Add todo
        </button>
      </div>

      <ul>
        {/* Map the child refs (stable identity, address-table cached) so each
            row binds its own CRDT text; key by the todo's stable id. */}
        {[...doc.todos].map(todoRef => (
          <TodoItem
            key={todoRef.id()}
            todoRef={todoRef}
            autoFocus={todoRef.id() === newId}
            onEnter={addTodo}
          />
        ))}
      </ul>

      {todos.length === 0 && (
        <p className="empty-state">No todos yet. Add one above!</p>
      )}

      <p className="hint">
        Open this page in another tab to see real-time collaborative editing!
      </p>
    </div>
  )
}
