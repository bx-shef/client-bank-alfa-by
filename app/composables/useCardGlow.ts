/**
 * Прокидывает координаты курсора в CSS-переменные --glow-x/--glow-y
 * для элементов с [data-glow-card] — даёт «следящий» glow за мышью,
 * как на vibecode.bitrix24.tech.
 *
 * При уходе курсора с карточки переменные сбрасываются, иначе glow
 * прыгает к последней позиции при следующем наведении.
 */
export function useCardGlow(): void {
  const handleMove = (e: MouseEvent) => {
    const target = (e.target as Element | null)?.closest('[data-glow-card]') as HTMLElement | null
    if (!target) return
    const r = target.getBoundingClientRect()
    target.style.setProperty('--glow-x', `${e.clientX - r.left}px`)
    target.style.setProperty('--glow-y', `${e.clientY - r.top}px`)
  }

  const handleLeave = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target?.matches?.('[data-glow-card]')) return
    // Не сбрасываем если курсор ушёл на дочерний элемент карточки
    if (target.contains(e.relatedTarget as Node | null)) return
    target.style.removeProperty('--glow-x')
    target.style.removeProperty('--glow-y')
  }

  onMounted(() => {
    document.addEventListener('mousemove', handleMove, { passive: true })
    // mouseleave не всплывает — слушаем через делегированный mouseout
    document.addEventListener('mouseout', handleLeave, { passive: true })
  })

  onUnmounted(() => {
    document.removeEventListener('mousemove', handleMove)
    document.removeEventListener('mouseout', handleLeave)
  })
}
