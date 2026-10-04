# Ask tool

`ask` has two actions, `clarification` and `approval`. It is available in every workspace without requiring a folder and uses normal bot tool assignments. Custom tools cannot shadow its reserved name.

For clarification, provide a focused question and 2–6 distinct suggested answers. Mark exactly one option recommended. The user may choose any suggestion or type a custom answer; recommendations are not preselected.

```json
{
  "action": "clarification",
  "question": "Which audience should I focus on?",
  "options": [
    { "label": "New customers", "description": "Reach a wider audience.", "recommended": true },
    { "label": "Existing customers", "description": "Focus on retention.", "recommended": false }
  ]
}
```

The result is `{ "action": "clarification", "answer": "the actual user answer" }`.

For approval, omit options and describe the proposed decision:

```json
{ "action": "approval", "question": "May I publish this draft?" }
```

The card has Approve and Deny buttons. The result is `{ "action": "approval", "approved": true | false }`. Asking does not perform the proposed action, and a denial does not authorize it. Subsequent external tool calls still follow the installation's tool approval policy.

Ask cards temporarily replace the composer until answered or cancelled. Suggested answers use numbered rows with inline descriptions; the free-text row accepts a custom answer. Parallel ask requests have Previous and Next controls, and retain drafts while paging. Skip explicitly tells the bot the user is skipping the question; the close control stops the response without answering.

Both actions always pause for a human response, even in Full access. They share conversation-scoped composer cards, the grouped Pending Approvals page, notifications, and exact links to private chats, spaces and pursuit runs. There is no extra tool-permission prompt before an ask question. Mixed parallel batches with clarifications require individual responses; they cannot be granted through Approve all.

Pending questions survive app shutdown and restart. Answers and decisions are checkpointed before their cards clear, so completed questions are reused while sibling calls remain pending. Stop cancels a question without inventing an answer.
