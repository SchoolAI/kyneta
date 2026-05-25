import { Schema } from "./packages/schema/src/schema.js";
import { loro } from "./packages/schema/backends/loro/src/bind-loro.js";
import { createDoc } from "./packages/schema/src/create-doc.js";

const WorkspaceSchema = Schema.struct({
  mode: Schema.string(
    "welcome",
    "reading-practice",
    "reading-comprehension",
    "free-play",
  ),
  visualText: Schema.string().nullable(),
  imageUrl: Schema.string(),
  imagePrompt: Schema.string(),
})

const WorkspaceDoc = loro.bind(WorkspaceSchema)
const workspaceDoc = createDoc(WorkspaceDoc)
const doc = workspaceDoc()
