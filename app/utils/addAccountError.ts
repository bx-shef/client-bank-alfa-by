// Сообщение администратору, когда не удалось добавить счёт к подключению (#23).
//
// Отдельный чистый модуль по той же причине, что и `setAccountError.ts`: `frameFetchError`
// подклеил бы английский текст сервера, а здесь ровно тот случай, ради которого сообщение и
// читают — исходы РАЗНЫЕ, и каждый требует своего следующего шага, а не общего «попробуйте ещё».
//
// ⚠ Три из четырёх отказов отвечают 409, и слить их в один текст было бы худшим решением: «счёт
// уже подключён» лечится другим номером, «список устарел» — обновлением страницы, а «подключение
// заведено до поддержки нескольких счетов» — повторным подключением, то есть походом ВЛАДЕЛЬЦА
// СЧЁТА в интернет-банк. Одинаковая фраза на все три отправила бы человека не туда дважды из трёх.
// Различить их можно только по телу ответа, поэтому здесь смотрят и на него.

/** HTTP-статус из отказа `$fetch` (FetchError) либо axios-подобной ошибки. */
export function addAccountErrorStatus(e: unknown): number | undefined {
  const err = e as { statusCode?: number, response?: { status?: number } } | null | undefined
  return err?.statusCode ?? err?.response?.status
}

/** Текст ошибки, который вернул сервер (для разведения одинаковых статусов). */
function serverError(e: unknown): string {
  const err = e as { data?: { error?: unknown } } | null | undefined
  return typeof err?.data?.error === 'string' ? err.data.error : ''
}

/** Текст для администратора по ответу `/api/bank/add-account`. */
export function addAccountErrorMessage(e: unknown): string {
  const status = addAccountErrorStatus(e)
  const reason = serverError(e)
  if (status === 409 && reason.includes('predates')) {
    return 'Это подключение заведено до поддержки нескольких счетов. Подключите банк заново — тогда счета можно будет добавлять без повторного входа.'
  }
  if (status === 409 && reason.includes('out of date')) {
    return 'Список устарел — обновите страницу и повторите.'
  }
  if (status === 409 && reason.includes('choose the account')) {
    return 'Сначала укажите счёт самого подключения.'
  }
  if (status === 409) return 'Этот счёт уже подключён — выберите другой номер.'
  if (status === 404) return 'Подключение не найдено: возможно, его уже отключили. Обновите список.'
  if (status === 403) return 'Добавлять счета может только администратор портала.'
  if (status === 400) return 'Проверьте номер счёта: допустимы только буквы и цифры.'
  return 'Не удалось добавить счёт — попробуйте ещё раз.'
}
