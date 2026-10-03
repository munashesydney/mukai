import { ApiError } from '../config';

function occurrences(text: string, search: string) {
  const positions: number[] = [];
  for (let from = 0; from <= text.length;) {
    const index = text.indexOf(search, from);
    if (index < 0) break;
    positions.push(index);
    from = index + 1;
  }
  return positions;
}

// Keep an offset map: normalized matches must replace the original bytes only.
function normalize(text: string) {
  let value = '';
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r' && text[index + 1] === '\n') continue;
    if (text[index] === ' ' || text[index] === '\t') {
      let end = index;
      while (text[end] === ' ' || text[end] === '\t') end++;
      if (
        end === text.length ||
        text[end] === '\n' ||
        (text[end] === '\r' && text[end + 1] === '\n')
      ) {
        index = end - 1;
        continue;
      }
      for (; index < end; index++) {
        offsets.push(index);
        value += text[index];
      }
      index--;
      continue;
    }
    offsets.push(text[index] === '\n' && text[index - 1] === '\r' ? index - 1 : index);
    value += text[index];
  }
  offsets.push(text.length);
  return { value, offsets };
}

export function patchText(text: string, oldText: string, newText: string) {
  let matches = occurrences(text, oldText);
  let start = matches[0];
  let end = start + oldText.length;
  let mode = 'exact';
  if (!matches.length) {
    const source = normalize(text);
    const search = normalize(oldText).value;
    matches = search.trim() ? occurrences(source.value, search) : [];
    start = source.offsets[matches[0]];
    end = source.offsets[matches[0] + search.length];
    mode = 'normalized whitespace';
  }
  if (matches.length !== 1) {
    const reason = matches.length
      ? `Found ${matches.length} matches (${mode}); oldText must match exactly once. Include more surrounding context.`
      : 'No matching text found, including after newline/trailing-whitespace normalization. Read the current file and copy a unique oldText from it.';
    throw new ApiError(409, `${reason} No edits were made.`);
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const replacement = newText.replace(/\r\n|\n/g, newline);
  return text.slice(0, start) + replacement + text.slice(end);
}
