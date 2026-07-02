// Plain TS singleton mapping command ids -> runnable actions. Consumed by the
// command palette (fuzzy list) and the KeybindingService (direct dispatch).

export interface ActionContext {
  activeTabId: string | null
  activePaneId: string | null
  activeSessionId: string | null
}

export interface AppAction {
  id: string
  title: string
  keywords?: string[]
  section: string
  when?: (ctx: ActionContext) => boolean
  run: (ctx: ActionContext) => void | Promise<void>
}

/** Dynamic action sources (live sessions, workflows) evaluated per query. */
export type ActionProvider = () => AppAction[]

class ActionRegistry {
  private actions = new Map<string, AppAction>()
  private providers = new Set<ActionProvider>()

  register(action: AppAction): () => void {
    this.actions.set(action.id, action)
    return () => {
      if (this.actions.get(action.id) === action) this.actions.delete(action.id)
    }
  }

  registerMany(actions: AppAction[]): () => void {
    const disposers = actions.map((a) => this.register(a))
    return () => disposers.forEach((d) => d())
  }

  registerProvider(provider: ActionProvider): () => void {
    this.providers.add(provider)
    return () => {
      this.providers.delete(provider)
    }
  }

  /** All actions currently applicable in `ctx` (when-guards applied). */
  all(ctx: ActionContext): AppAction[] {
    const out: AppAction[] = []
    for (const a of this.actions.values()) if (!a.when || a.when(ctx)) out.push(a)
    for (const p of this.providers) {
      for (const a of p()) if (!a.when || a.when(ctx)) out.push(a)
    }
    return out
  }

  get(id: string, ctx: ActionContext): AppAction | undefined {
    const direct = this.actions.get(id)
    if (direct) return direct
    return this.all(ctx).find((a) => a.id === id)
  }

  /** Returns false when the action is missing or its when-guard rejects. */
  run(id: string, ctx: ActionContext): boolean {
    const action = this.get(id, ctx)
    if (!action || (action.when && !action.when(ctx))) return false
    void action.run(ctx)
    return true
  }
}

export const actionRegistry = new ActionRegistry()
