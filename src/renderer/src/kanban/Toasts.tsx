import { useToastStore } from './toastStore'

export function Toasts(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onClick={() => useToastStore.getState().dismiss(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
