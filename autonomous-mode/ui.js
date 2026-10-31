// @ts-check
import { createAutonomyController } from "./controller.js"

const STYLE_ID = "autonomous-mode-style"
const HOST_ID = "autonomous-mode-toggle"
const TEXT = {
  off: "Работать автоматически",
  on: "Автоматически: включено",
  enabling: "Включаем…",
  disabling: "Выключаем…",
  error: "Автоматически: ошибка",
  title: "Автономный режим",
  disclaimer:
    "После включения OpenCode будет выполнять действия в этой сессии без запросов подтверждения: сможет изменять и удалять файлы, запускать команды, обращаться к сети и изменять другие данные. Действия могут быть необратимыми. Явные запреты и системные политики остаются в силе. Вы принимаете риски и можете выключить режим в любой момент.",
  confirm: "Понимаю риски, включить",
  cancel: "Отмена",
  close: "Закрыть предупреждение",
  failed: "Не удалось изменить режим. Проверьте соединение и повторите.",
  conflict: "Правила изменились в другом месте. Автономный режим выключен; чужие изменения сохранены.",
}

const css = `
#${HOST_ID} { margin-left:auto; display:flex; align-items:center; min-width:0; }
#${HOST_ID} .autonomy-button { appearance:none; border:1px solid var(--border-base,#555); border-radius:6px; background:transparent; color:var(--text-base,#ddd); padding:5px 9px; font:12px/1.2 inherit; cursor:pointer; white-space:nowrap; }
#${HOST_ID} .autonomy-button:hover:not(:disabled) { background:var(--background-stronger,#333); }
#${HOST_ID} .autonomy-button:focus-visible { outline:2px solid var(--border-focus,#7ab); outline-offset:2px; }
#${HOST_ID} .autonomy-button[aria-checked="true"] { color:var(--text-warning-base,#f4bf75); border-color:var(--border-warning-base,#a66b22); }
#${HOST_ID} .autonomy-button:disabled { opacity:.55; cursor:wait; }
.autonomy-backdrop { position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(0,0,0,.62); }
.autonomy-dialog { box-sizing:border-box; width:min(520px,100%); max-height:90dvh; overflow:auto; border:1px solid var(--border-base,#555); border-radius:12px; background:var(--background-base,#171717); color:var(--text-base,#eee); padding:22px; box-shadow:0 20px 80px #0008; font:14px/1.5 sans-serif; }
.autonomy-dialog h2 { margin:0 0 14px; font-size:18px; }
.autonomy-dialog p { margin:0 0 20px; white-space:normal; overflow-wrap:anywhere; }
.autonomy-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; }
.autonomy-actions button { border:1px solid var(--border-base,#666); border-radius:6px; padding:8px 12px; background:transparent; color:inherit; cursor:pointer; }
.autonomy-actions .autonomy-confirm { background:var(--background-warning-base,#8a4b12); color:#fff; }
.autonomy-toast { position:fixed; z-index:2147483001; bottom:24px; left:50%; transform:translateX(-50%); max-width:min(560px,90vw); padding:12px 16px; border-radius:8px; background:#421e1e; color:#fff; font:13px/1.4 sans-serif; box-shadow:0 4px 20px #0006; }
`

export function mountAutonomyUI({ window, document, read, update, currentSession, setInterval, clearInterval }) {
  let destroyed = false
  let dialog
  let toast
  let toastTimer
  let dialogGeneration = 0
  let previousFocus
  const host = document.createElement("div")
  host.id = HOST_ID
  const button = document.createElement("button")
  button.type = "button"
  button.className = "autonomy-button"
  button.setAttribute("role", "switch")
  button.setAttribute("aria-label", TEXT.off)
  button.addEventListener("click", () => void clicked())
  host.append(button)

  const style = document.getElementById(STYLE_ID) ?? document.createElement("style")
  style.id = STYLE_ID
  style.textContent = css
  if (!style.isConnected) document.head.append(style)

  const controller = createAutonomyController({ read, update }, render)
  const observer = new MutationObserver(place)
  observer.observe(document.body, { childList: true, subtree: true })
  const timer = setInterval(sync, 1500)
  window.addEventListener("pagehide", destroy, { once: true })
  sync()

  function current() {
    try {
      const url = new window.URL(window.location.href)
      const match = url.pathname.match(/\/session\/(ses_[A-Za-z0-9_-]{1,256})(?:\/|$)/)
      if (match) return match[1]
      const encoded = url.searchParams.get("session") ?? url.searchParams.get("sessionID")
      if (encoded && /^ses_[A-Za-z0-9_-]{1,256}$/.test(encoded)) return encoded
      return currentSession?.()
    } catch {
      return undefined
    }
  }

  function sync() {
    if (destroyed) return
    const previous = controller.snapshot().sessionID
    controller.select(current())
    if (previous !== controller.snapshot().sessionID) void controller.refresh()
    place()
  }

  function place() {
    if (destroyed || !document.body) return
    if (!controller.snapshot().sessionID) {
      host.remove()
      closeDialog()
      return
    }
    const composer = findComposer(document)
    if (!composer) {
      host.remove()
      return
    }
    composer.append(host)
    render(controller.snapshot().state)
  }

  function render(state) {
    button.textContent = TEXT[state.status] ?? TEXT.error
    button.setAttribute("aria-checked", String(state.status === "on"))
    button.setAttribute("aria-label", `${button.textContent}. ${TEXT.off}`)
    button.disabled = state.status === "enabling" || state.status === "disabling" || !controller.snapshot().sessionID
    button.dataset.state = state.status
  }

  async function clicked() {
    if (dialog) return
    const snapshot = controller.snapshot()
    if (!snapshot.sessionID) return
    if (snapshot.state.status === "on") {
      const result = await controller.disable()
      if (!result.ok) notify(result.reason)
      return
    }
    showDisclaimer()
  }

  function showDisclaimer() {
    closeDialog()
    previousFocus = document.activeElement
    const ownSession = controller.snapshot().sessionID
    const ownDialog = ++dialogGeneration
    const backdrop = document.createElement("div")
    backdrop.className = "autonomy-backdrop"
    const panel = document.createElement("section")
    panel.className = "autonomy-dialog"
    panel.setAttribute("role", "alertdialog")
    panel.setAttribute("aria-modal", "true")
    panel.setAttribute("aria-labelledby", "autonomy-title")
    panel.setAttribute("aria-describedby", "autonomy-description")
    const title = document.createElement("h2")
    title.id = "autonomy-title"
    title.textContent = TEXT.title
    const text = document.createElement("p")
    text.id = "autonomy-description"
    text.textContent = TEXT.disclaimer
    const actions = document.createElement("div")
    actions.className = "autonomy-actions"
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.textContent = TEXT.cancel
    cancel.setAttribute("aria-label", TEXT.close)
    const confirm = document.createElement("button")
    confirm.type = "button"
    confirm.className = "autonomy-confirm"
    confirm.textContent = TEXT.confirm
    cancel.addEventListener("click", closeDialog)
    confirm.addEventListener("click", async () => {
      if (ownSession !== controller.snapshot().sessionID) return closeDialog()
      cancel.disabled = true
      confirm.disabled = true
      const result = await controller.enable(true)
      if (ownDialog !== dialogGeneration) return
      closeDialog()
      if (!result.ok) notify(result.reason)
    })
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog()
    })
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeDialog()
      }
      if (event.key === "Tab") {
        event.preventDefault()
        ;(document.activeElement === confirm ? cancel : confirm).focus()
      }
    })
    actions.append(cancel, confirm)
    panel.append(title, text, actions)
    backdrop.append(panel)
    document.body.append(backdrop)
    dialog = backdrop
    cancel.focus()
  }

  function closeDialog() {
    dialogGeneration++
    dialog?.remove()
    dialog = undefined
    if (previousFocus?.isConnected) previousFocus.focus()
  }

  function notify(reason) {
    toast?.remove()
    window.clearTimeout(toastTimer)
    toast = document.createElement("div")
    toast.className = "autonomy-toast"
    toast.setAttribute("role", "alert")
    toast.textContent = reason === "conflict" ? TEXT.conflict : TEXT.failed
    document.body.append(toast)
    toastTimer = window.setTimeout(() => {
      toast?.remove()
      toast = undefined
    }, 8000)
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    observer.disconnect()
    clearInterval(timer)
    window.clearTimeout(toastTimer)
    closeDialog()
    toast?.remove()
    host.remove()
    if (style.isConnected) style.remove()
  }

  return { destroy, controller, button, host, sync }
}

export function findComposer(document) {
  const candidates = [...document.querySelectorAll('[data-component="composer"], form, [contenteditable="true"]')]
  for (const candidate of candidates.reverse()) {
    if (candidate.id === HOST_ID || candidate.closest(`#${HOST_ID}`)) continue
    const root = candidate.matches("form") ? candidate : candidate.closest("form") ?? candidate.parentElement
    const actions = root?.querySelector('textarea, [contenteditable="true"]')?.closest("div")?.parentElement?.parentElement
    if (actions?.isConnected) return actions
  }
  return undefined
}
