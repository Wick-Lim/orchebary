import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  kind: 'error' | 'info'
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, kind: Toast['kind']) => void
  dismiss: (id: number) => void
}

let nextId = 1
const TOAST_TTL_MS = 5000

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_TTL_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export function showToast(message: string, kind: Toast['kind'] = 'error'): void {
  useToastStore.getState().push(message, kind)
}

export function showError(err: unknown, prefix?: string): void {
  const msg = err instanceof Error ? err.message : String(err)
  showToast(prefix ? `${prefix}: ${msg}` : msg, 'error')
}
