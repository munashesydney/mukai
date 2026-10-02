export function chatRoot(id: string) {
  return id.startsWith('space:') || id.startsWith('private:')
    ? `/conversations/${encodeURIComponent(id.slice(id.indexOf(':') + 1))}`
    : `/bots/${encodeURIComponent(id)}`;
}
export function chatConversationId(id: string) {
  return id.startsWith('space:') || id.startsWith('private:')
    ? id.slice(id.indexOf(':') + 1)
    : 'bot-' + id;
}
