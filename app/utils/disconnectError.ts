// Сообщение администратору, когда не удалось отключить подключение банка (#517).
//
// Отдельно от `frameFetchError` по той же причине, что и `setAccountError.ts`: тот подклеивает
// английский текст сервера, а среди исходов есть «список устарел, обновите» — совет, ради которого
// сообщение и читают. Форма — как у `loginError.ts`/`setAccountError.ts`: статус → текст, чисто и
// под тестом.

/** HTTP-статус из отказа `$fetch` (FetchError) либо axios-подобной ошибки. */
export function disconnectErrorStatus(e: unknown): number | undefined {
  const err = e as { statusCode?: number, response?: { status?: number } } | null | undefined
  return err?.statusCode ?? err?.response?.status
}

/**
 * Текст по статусу ответа `/api/bank/disconnect`.
 *
 * ⚠ 409 здесь значит НЕ «так не будет никогда», а «строка изменилась под вами»: пока список висел
 * на экране, подключению назначили счёт, и оно перестало быть тем, что собирались убрать. Поэтому
 * текст зовёт обновить список, а не менять что-то в своих действиях.
 */
export function disconnectErrorMessage(e: unknown): string {
  const status = disconnectErrorStatus(e)
  if (status === 409) return 'Список устарел: подключение успело измениться. Обновите список и повторите.'
  if (status === 403) return 'Отключать подключения банка может только администратор портала.'
  if (status === 400) return 'Не удалось отключить: обновите список и повторите.'
  return 'Не удалось отключить счёт — попробуйте ещё раз.'
}
