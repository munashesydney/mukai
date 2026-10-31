import { toolApprovalPresentation } from '../../shared/toolApprovalPresentation';

/** Telegram presentation only. Never append this header to stored conversation messages or AI input. */
export const telegramBodyLimit = 3800;
function headerName(value: string) {
  let name = value.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').slice(0, 120);
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  return name;
}
export function telegramMessage(text: string, workspaceName?: string, botName?: string) {
  const prefix = `Workspace ${headerName(workspaceName || 'Not selected')}${botName ? '\nBot ' + headerName(botName) : ''}\n\n`;
  let body = text.slice(-(4096 - prefix.length));
  if (/^[\uDC00-\uDFFF]/.test(body)) body = body.slice(1);
  return prefix + body;
}

export const approvalDetails = toolApprovalPresentation;
