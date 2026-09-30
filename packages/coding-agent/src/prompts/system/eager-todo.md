<system-reminder>
{{#if forced}}
Before substantive work, create a phased todo.

You MUST call `{{toolRefs.todo}}` first in this turn.
You MUST initialize the todo list with a single `init` op.
You MUST cover the entire request's necessary steps — not just the next immediate step. NEVER add investigation, implementation, or verification phases that the request does not need.
Task descriptions MUST be concise, specific 5-10 word labels.
The `init` op only accepts phase names and task-label strings; do not invent task metadata fields.

After `{{toolRefs.todo}}` succeeds, continue the request in the same turn.
NEVER call `{{toolRefs.todo}}` again unless task state has materially changed.
{{else}}
Use `{{toolRefs.todo}}` when tracking dependencies or remaining work helps complete the request; skip it for a straightforward action. Initialize once with a single `init` op covering only necessary steps, with descriptions a future turn can execute without re-planning. NEVER add phases to fill a list.
A useful list keeps each task to a concise, specific 5-10 word label; the `init` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.
If you create the list, continue the request in the same turn and avoid re-calling `{{toolRefs.todo}}` unless task state materially changes.
{{/if}}
</system-reminder>
