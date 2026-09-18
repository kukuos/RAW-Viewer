// 主题切换:shadcn class 策略,持久化到 localStorage(沿用旧键 rawviewer-theme)
import { useCallback, useEffect, useState } from 'react'

const THEME_LS = 'rawviewer-theme'

export type Theme = 'light' | 'dark'

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem(THEME_LS) === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try { localStorage.setItem(THEME_LS, theme) } catch { /* ignore */ }
  }, [theme])

  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), [])

  return { theme, toggleTheme }
}
