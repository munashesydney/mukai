# Files, images, and charts in responses

Mukai renders ordinary Markdown with internal file destinations and one declarative chart block. These formats are available across providers and survive message history reloads. They do not execute model-generated HTML or JavaScript.

## File references

```markdown
[Open report](mukai://artifact/ARTIFACT_ID)
[Original upload](mukai://attachment/ATTACHMENT_ID)
![Render](mukai://artifact/IMAGE_ARTIFACT_ID)
[Source line](src/app.ts#L42)
![Workspace image](renders/chair.png)
```

Use actual IDs/references returned by tools. File writes, patches, copies inside the workspace, screenshots, image reads, and conversation artifact searches return references. Upserting an artifact returns its existing canonical ID.

Relative paths resolve in the conversation's workspace. Absolute paths must remain inside the local workspace folder or `/home/mukai/workspace` in VM mode. `mukai://file/ENCODED_PATH` also accepts a percent-encoded path. `#L42` highlights a line in the text preview. Code spans and prose are not automatically interpreted as paths. Path reads retain the file tool's protections for private data, protected names, links, and junctions. Outside-workspace files must be copied into the workspace before linking them.

IDs resolve in the conversation's workspace. Uploads and managed screenshots use retained storage; ordinary generated-file records still point to their current workspace files. An ID does not make a deleted workspace file available again. Missing files show an error in the preview.

Image embeds load lazily through the authenticated backend and normalize supported PNG/JPEG/WebP data. Remote Markdown images are not fetched automatically. Links open a cancellable preview with download support. Binary files and text over 256 KiB get a download fallback rather than an oversized text rendering.

## Charts

````markdown
```mukai-chart
{"version":1,"type":"line","title":"Revenue","xKey":"month","series":[{"key":"revenue","label":"Revenue"}],"data":[{"month":"Jan","revenue":900},{"month":"Feb","revenue":1150}]}
```
````

Version 1 supports `bar` and `line`. `series` contains 1–4 unique keys, distinct from `xKey`. `data` contains 1–500 rows with an x label/value and a numeric value or `null` for every series. Nulls create gaps, never zero values. Numbers must be finite and between -1e12 and 1e12. Keys use letters, digits, and underscores, starting with a letter. Unknown specification properties are rejected. Label strings are rendered as text.

Charts offer hover/focus details, a data table, and a CSV download. Data order is preserved. Identify illustrative data clearly and do not invent measurements.

For saved specifications, write the complete JSON chart specification into a workspace file and use:

````markdown
```mukai-chart
{"version":1,"source":"mukai://artifact/CHART_JSON_ARTIFACT_ID"}
```
````

`source` may also be a workspace path. Inline specifications are limited to 64 KiB; saved specifications to 256 KiB, with the same series/row limits. Nested sources and network URLs are not accepted. Only a completed matching code fence is rendered; an incomplete streaming block remains a loading message. Invalid specifications display feedback without executing anything.
