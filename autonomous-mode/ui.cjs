// @ts-check
"use strict"

const { createAutonomyController } = require("./controller.cjs")

const STYLE_ID = "autonomous-mode-style"
const HOST_ID = "autonomous-mode-toggle"
const SESSION_PATH = /(?:^|[/\n])session\/(ses_[A-Za-z0-9_-]{1,256})(?=$|[/?#\n])/

const TEXT = {
  off: "Не спрашивать",
  on: "Не спрашивать: вкл",
  enabling: "Включаем…",
  disabling: "Выключаем…",
  error: "Не спрашивать: ошибка",
  aria: "Режим «Никогда не спрашивать»",
  status: {
    off: "выключен",
    on: "включён",
    enabling: "включается",
    disabling: "выключается",
    error: "ошибка",
  },
  tooltip: "Никогда не спрашивать: автоматически разрешать новые запросы",
  title: "Включить режим «Никогда не спрашивать»?",
  lead: "OpenCode будет быстро отвечать «всегда» на новые запросы разрешений в этой сессии и её подсессиях.",
  risks: [
    "изменять и удалять файлы;",
    "запускать команды;",
    "обращаться к сети;",
    "изменять другие данные.",
  ],
  tail: "Действия могут быть необратимыми. Явные запреты и системные политики остаются в силе. Запросы, которые уже ждут ответа, не подтверждаются автоматически. OpenCode может сохранить разрешения «всегда» для предложенных инструментом шаблонов; они могут продолжать действовать после выключения режима.",
  confirm: "Понимаю риски, включить",
  cancel: "Отмена",
  close: "Закрыть предупреждение",
  closeToast: "Закрыть уведомление",
  failed: "Не удалось изменить режим. Проверьте соединение и повторите.",
  unavailable: "Откройте сессию, чтобы изменить режим «Никогда не спрашивать».",
  enabled: "Режим «Никогда не спрашивать» включён: новые запросы будут автоматически разрешаться.",
  disabled: "Режим «Никогда не спрашивать» выключен.",
}

const CSS = `
#${HOST_ID} { margin-left:8px; flex:0 0 auto; display:flex; align-items:center; min-width:0; }
#${HOST_ID}[hidden] { display:none !important; }
#${HOST_ID} .autonomy-button {
  appearance:none; -webkit-appearance:none; box-sizing:border-box;
  display:inline-flex; align-items:center; gap:6px; height:28px; max-width:100%;
  margin:0; padding:0 7px; border:1px solid transparent; border-radius:6px;
  background:transparent; color:var(--v2-text-text-muted,#666);
  font:500 12px/1 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  white-space:nowrap; cursor:pointer; user-select:none;
}
#${HOST_ID} .autonomy-button:hover:not(:disabled) {
  background:var(--v2-background-bg-layer-01,rgba(0,0,0,.05));
  color:var(--v2-text-text-base,#111);
}
#${HOST_ID} .autonomy-button:focus-visible {
  outline:2px solid var(--v2-border-border-focus,#3b82f6); outline-offset:2px;
}
#${HOST_ID} .autonomy-button:disabled { opacity:.65; cursor:progress; }
#${HOST_ID} .autonomy-button[data-status="on"] {
  color:var(--v2-state-fg-warning,#8a5a00);
  background:var(--v2-state-bg-warning,#fff3cd);
  border-color:var(--v2-state-border-warning,#e5c07b);
}
#${HOST_ID} .autonomy-button[data-status="error"] {
  color:var(--v2-state-fg-danger,#a12a2a);
  background:var(--v2-state-bg-danger,#fde8e8);
  border-color:var(--v2-state-border-danger,#e7a0a0);
}
#${HOST_ID} .autonomy-track {
  position:relative; flex:0 0 auto; width:24px; height:14px; border-radius:999px;
  background:var(--v2-border-border-strong,#b8b8b8); transition:background-color .15s ease;
}
#${HOST_ID} .autonomy-knob {
  position:absolute; top:2px; left:2px; width:10px; height:10px; border-radius:50%;
  background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.25);
  transition:transform .15s ease;
}
#${HOST_ID} .autonomy-button[aria-checked="true"] .autonomy-track {
  background:var(--v2-state-fg-warning,#a66b22);
}
#${HOST_ID} .autonomy-button[aria-checked="true"] .autonomy-knob { transform:translateX(10px); }
#${HOST_ID} .autonomy-label { overflow:hidden; text-overflow:ellipsis; }
.autonomy-backdrop {
  position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center;
  justify-content:center; padding:24px; background:rgba(0,0,0,.55);
}
.autonomy-dialog {
  box-sizing:border-box; width:min(540px,100%); max-height:90dvh; overflow:auto;
  border:1px solid var(--v2-border-border-strong,#ccc); border-radius:12px;
  background:var(--v2-background-bg-base,#fff); color:var(--v2-text-text-base,#111);
  padding:22px; box-shadow:0 24px 80px rgba(0,0,0,.35);
  font:13px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  text-align:left;
}
.autonomy-dialog h2 { margin:0 0 12px; font-size:18px; line-height:1.25; }
.autonomy-dialog p { margin:0 0 12px; white-space:normal; overflow-wrap:anywhere; }
.autonomy-dialog ul { margin:0 0 12px; padding-left:22px; }
.autonomy-dialog li { margin:2px 0; }
.autonomy-dialog .autonomy-actions {
  display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; margin-top:20px;
}
.autonomy-dialog .autonomy-actions button {
  appearance:none; -webkit-appearance:none; box-sizing:border-box;
  border:1px solid var(--v2-border-border-strong,#ccc); border-radius:7px;
  padding:8px 13px; background:transparent; color:inherit;
  font:500 13px/1.2 inherit; cursor:pointer;
}
.autonomy-dialog .autonomy-actions button:hover:not(:disabled) { background:var(--v2-background-bg-layer-01,rgba(0,0,0,.05)); }
.autonomy-dialog .autonomy-actions button:focus-visible { outline:2px solid var(--v2-border-border-focus,#3b82f6); outline-offset:2px; }
.autonomy-dialog .autonomy-actions button:disabled { opacity:.6; cursor:progress; }
.autonomy-dialog .autonomy-confirm {
  border-color:var(--v2-state-border-warning,#c58a2a) !important;
  background:var(--v2-state-bg-warning,#fff3cd) !important;
  color:var(--v2-state-fg-warning,#7a4d00) !important;
}
.autonomy-toast {
  position:fixed; z-index:2147483001; bottom:24px; left:50%; transform:translateX(-50%);
  box-sizing:border-box; display:flex; align-items:flex-start; gap:10px;
  max-width:min(560px,calc(100vw - 32px)); padding:11px 12px 11px 14px;
  border:1px solid var(--v2-border-border-strong,#ccc); border-radius:9px;
  background:var(--v2-background-bg-base,#fff); color:var(--v2-text-text-base,#111);
  box-shadow:0 8px 30px rgba(0,0,0,.25);
  font:13px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
}
.autonomy-toast[data-kind="error"] {
  border-color:var(--v2-state-border-danger,#d88);
  background:var(--v2-state-bg-danger,#fde8e8);
  color:var(--v2-state-fg-danger,#8f1f1f);
}
.autonomy-toast span { overflow-wrap:anywhere; }
.autonomy-toast button {
  appearance:none; -webkit-appearance:none; flex:0 0 auto; border:0; background:transparent;
  color:inherit; padding:0 2px; margin:0; font:inherit; cursor:pointer; opacity:.75;
}
.autonomy-toast button:hover { opacity:1; }
.autonomy-toast button:focus-visible { outline:2px solid currentColor; outline-offset:2px; border-radius:3px; }
@media (prefers-reduced-motion: reduce) {
  #${HOST_ID} .autonomy-track, #${HOST_ID} .autonomy-knob { transition:none; }
}
`

function validSession(value) {
  return typeof value === "string" && /^ses_[A-Za-z0-9_-]{1,256}$/.test(value)
}

function sessionFrom(value) {
  if (typeof value !== "string") return undefined
  const match = value.match(SESSION_PATH)
  return match ? match[1] : undefined
}

function findSession(document, currentSession) {
  const active = document.querySelector('[data-tab-key][data-active="true"]')
  if (active) {
    const direct = sessionFrom(active.getAttribute("data-tab-key"))
    if (direct) return direct
    const link = active.querySelector('a[href*="/session/"]')
    const linked = sessionFrom(link?.getAttribute("href"))
    if (linked) return linked
  }
  if (typeof currentSession === "function") {
    try {
      const value = currentSession()
      if (validSession(value)) return value
    } catch {
      // Ignore an unavailable route hint.
    }
  }
  return undefined
}

function isVisible(element) {
  if (!element.isConnected) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function findComposer(document) {
  const forms = [...document.querySelectorAll('form[data-component="composer"]')]
  if (forms.length === 0) return undefined
  const visible = forms.filter(isVisible)
  const pool = visible.length > 0 ? visible : forms
  const form = pool[pool.length - 1]

  const submit = form.querySelector('[data-action="composer-submit"]')
  const submitWrapper = submit?.parentElement
  const row = submitWrapper?.parentElement
  if (row && row !== form && form.contains(row)) return { form, row, before: submitWrapper }

  const attach = form.querySelector('[data-action="composer-attach"]')
  const attachWrapper = attach?.parentElement
  const attachRow = attachWrapper?.parentElement
  if (attachRow && attachRow !== form && form.contains(attachRow)) return { form, row: attachRow, before: null }

  const last = form.lastElementChild
  if (last && last !== form) return { form, row: last, before: last.lastElementChild }
  return { form, row: form, before: null }
}

function mountAutonomyUI(options) {
  const {
    window,
    document,
    state: readState,
    enable,
    disable,
    currentSession,
    setInterval = window.setInterval.bind(window),
    clearInterval = window.clearInterval.bind(window),
  } = options
  if (typeof readState !== "function" || typeof enable !== "function" || typeof disable !== "function") {
    throw new TypeError("Autonomy API is unavailable")
  }

  let destroyed = false
  let dialog
  let dialogGeneration = 0
  let previousFocus
  let toast
  let toastTimer
  let scheduleTimer
  let disposed = false

  const host = document.createElement("div")
  host.id = HOST_ID
  const button = document.createElement("button")
  button.type = "button"
  button.className = "autonomy-button"
  button.setAttribute("role", "switch")
  button.setAttribute("aria-checked", "false")
  button.setAttribute("aria-label", `${TEXT.aria}: ${TEXT.status.off}`)
  button.title = TEXT.tooltip
  const track = document.createElement("span")
  track.className = "autonomy-track"
  track.setAttribute("aria-hidden", "true")
  const knob = document.createElement("span")
  knob.className = "autonomy-knob"
  track.append(knob)
  const label = document.createElement("span")
  label.className = "autonomy-label"
  label.textContent = TEXT.off
  button.append(track, label)
  host.append(button)

  const style = document.getElementById(STYLE_ID) ?? document.createElement("style")
  style.id = STYLE_ID
  if (style.textContent !== CSS) style.textContent = CSS
  if (!style.isConnected) document.head.append(style)

  const controller = createAutonomyController({ state: readState, enable, disable }, () =>
    render(controller.snapshot().state),
  )

  const observer =
    typeof window.MutationObserver === "function"
      ? new window.MutationObserver(() => schedule())
      : undefined
  if (observer && document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-active", "data-tab-key"],
    })
  }

  const timer = setInterval(() => {
    if (destroyed || dialog) return
    if (controller.snapshot().sessionID) void controller.refresh()
  }, 3_000)

  const onFocus = () => {
    if (destroyed || dialog) return
    if (controller.snapshot().sessionID) void controller.refresh()
    schedule()
  }
  window.addEventListener("focus", onFocus)
  window.addEventListener("resize", placeToast)
  window.addEventListener("pagehide", destroy, { once: true })

  button.addEventListener("click", () => void clicked())
  sync()

  function schedule() {
    if (destroyed || scheduleTimer) return
    scheduleTimer = window.setTimeout(() => {
      scheduleTimer = undefined
      sync()
    }, 80)
  }

  function sync() {
    if (destroyed) return
    const next = findSession(document, currentSession)
    const changed = controller.select(next)
    if (changed) {
      closeDialog()
      clearToast()
      if (next) void controller.refresh()
    }
    place()
    render(controller.snapshot().state)
  }

  function place() {
    if (destroyed || !document.body) return false
    const found = findComposer(document)
    if (!found) {
      host.remove()
      return false
    }
    if (host.parentElement !== found.row || (found.before && host.nextSibling !== found.before)) {
      if (found.before && found.before.parentElement === found.row) found.row.insertBefore(host, found.before)
      else found.row.append(host)
    }
    return true
  }

  function render(current) {
    const session = controller.snapshot().sessionID
    const status = session ? current.status : "off"
    const checked = Boolean(session && current.enabled)
    const labelText = TEXT[status] ?? TEXT.error
    const aria = `${TEXT.aria}: ${TEXT.status[status] ?? TEXT.status.error}`
    if (label.textContent !== labelText) label.textContent = labelText
    if (button.getAttribute("aria-checked") !== String(checked)) {
      button.setAttribute("aria-checked", String(checked))
    }
    if (button.getAttribute("aria-label") !== aria) button.setAttribute("aria-label", aria)
    if (button.dataset.status !== status) button.dataset.status = status
    const disabled = !session || status === "enabling" || status === "disabling"
    if (button.disabled !== disabled) button.disabled = disabled
    host.hidden = !session
  }

  async function clicked() {
    if (destroyed || dialog) return
    const snapshot = controller.snapshot()
    if (!snapshot.sessionID) return
    if (snapshot.state.status === "enabling" || snapshot.state.status === "disabling") return
    if (snapshot.state.enabled) {
      const result = await controller.disable()
      if (result.ok) notify(TEXT.disabled, "status")
      else handleFailure(result)
      return
    }
    showDisclaimer(snapshot.sessionID)
  }

  function showDisclaimer(ownSession) {
    closeDialog()
    previousFocus = document.activeElement
    const ownDialog = ++dialogGeneration
    const backdrop = document.createElement("div")
    backdrop.className = "autonomy-backdrop"
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog()
    })
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeDialog()
        return
      }
      if (event.key === "Tab") {
        event.preventDefault()
        ;(document.activeElement === confirm ? cancel : confirm).focus()
      }
    })

    const panel = document.createElement("section")
    panel.className = "autonomy-dialog"
    panel.setAttribute("role", "alertdialog")
    panel.setAttribute("aria-modal", "true")
    panel.setAttribute("aria-labelledby", "autonomy-dialog-title")
    panel.setAttribute("aria-describedby", "autonomy-dialog-description")

    const title = document.createElement("h2")
    title.id = "autonomy-dialog-title"
    title.textContent = TEXT.title
    const lead = document.createElement("p")
    lead.textContent = TEXT.lead
    const list = document.createElement("ul")
    for (const risk of TEXT.risks) {
      const item = document.createElement("li")
      item.textContent = risk
      list.append(item)
    }
    const tail = document.createElement("p")
    tail.id = "autonomy-dialog-description"
    tail.textContent = TEXT.tail
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
      confirm.textContent = TEXT.enabling
      const result = await controller.enable(true)
      if (ownDialog !== dialogGeneration) return
      closeDialog()
      if (result.ok) notify(TEXT.enabled, "status")
      else handleFailure(result)
      render(controller.snapshot().state)
    })
    actions.append(cancel, confirm)
    panel.append(title, lead, list, tail, actions)
    backdrop.append(panel)
    document.body.append(backdrop)
    dialog = backdrop
    cancel.focus()
  }

  function closeDialog() {
    dialogGeneration++
    if (dialog) {
      dialog.remove()
      dialog = undefined
    }
    if (previousFocus && previousFocus.isConnected) previousFocus.focus()
    previousFocus = undefined
  }

  function handleFailure(result) {
    if (!result || result.ok) return
    if (result.reason === "error") notify(TEXT.failed, "error")
    else if (result.reason === "unavailable" || result.reason === "not_found" || result.reason === "invalid") {
      notify(TEXT.unavailable, "error")
    }
  }

  function clearToast() {
    if (toast) {
      toast.remove()
      toast = undefined
    }
    window.clearTimeout(toastTimer)
    toastTimer = undefined
  }

  function placeToast() {
    if (!toast) return
    const composer = document.querySelector('form[data-component="composer"]')
    const rect = composer?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0 && rect.top > 96) {
      toast.style.bottom = `${Math.max(48, Math.round(window.innerHeight - rect.top + 12))}px`
    } else {
      toast.style.bottom = "24px"
    }
  }

  function notify(message, kind) {
    if (destroyed) return
    clearToast()
    toast = document.createElement("div")
    toast.className = "autonomy-toast"
    toast.dataset.kind = kind
    toast.setAttribute("role", kind === "error" ? "alert" : "status")
    const text = document.createElement("span")
    text.textContent = message
    const close = document.createElement("button")
    close.type = "button"
    close.textContent = "×"
    close.setAttribute("aria-label", TEXT.closeToast)
    close.addEventListener("click", clearToast)
    toast.append(text, close)
    document.body.append(toast)
    placeToast()
    toastTimer = window.setTimeout(clearToast, kind === "error" ? 9_000 : 6_000)
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    disposed = true
    observer?.disconnect()
    clearInterval(timer)
    clearToast()
    window.clearTimeout(scheduleTimer)
    window.removeEventListener("focus", onFocus)
    window.removeEventListener("resize", placeToast)
    closeDialog()
    host.remove()
    if (style.isConnected) style.remove()
  }

  return {
    destroy,
    controller,
    button,
    host,
    sync,
    get disposed() {
      return disposed
    },
  }
}

module.exports = {
  mountAutonomyUI,
  findComposer,
  findSession,
  TEXT,
}
