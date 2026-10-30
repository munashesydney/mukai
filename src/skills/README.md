# Bundled skills

Each skill uses a folder named after its SKILL.md frontmatter name:

```text
src/skills/
  index.ts                         # Registers bundled skills
  bundle.ts                        # Reads their Markdown assets
  mukai-custom-routes-authenticated-websites/
    index.ts                       # Lists this skill's files
    SKILL.md                       # Brief workflow, loaded on demand
    references/
      bot-api.md                   # Optional supporting instructions
```

Add a folder with a normal SKILL.md, list its files with bundledSkill in the folder's index.ts, then import that default export in src/skills/index.ts. Keep instructions in Markdown rather than TypeScript strings. Desktop, CLI and server builds ship these folders alongside the application.

Bundled skills use the existing workspace skills UI and tools. Updates refresh untouched copies while preserving user edits, disabled state, removals and pinned loaded versions.
