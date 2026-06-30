// Placeholder chat list for the settings selector. Real chats come from the
// Bitrix24 portal (im.* / dialog list) once the SDK transport lands; until then
// the UI is wired against this mock so the selection flow can be built/tested.
export interface ChatTarget {
  id: string
  /** Display name; in real integration comes from the portal (language-dependent). */
  title: string
}

export const MOCK_CHATS: readonly ChatTarget[] = [
  { id: 'chat1', title: 'Бухгалтерия' },
  { id: 'chat2', title: 'Руководство' },
  { id: 'chat3', title: 'Продажи' }
]
