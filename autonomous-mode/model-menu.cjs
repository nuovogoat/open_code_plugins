// Passive Desktop model-menu fixes. No application state, credentials or network access.
// @ts-check
"use strict"

const STYLE_ID = "autonomous-model-menu-style"
const COLLAPSED_ATTR = "data-autonomy-collapsed"
const EMPTY_ATTR = "data-autonomy-empty"
const MAX_REMEMBERED_GROUPS = 256

const CSS = `
[data-slot="model-selector-scroll"] > .scroll-view__thumb,
[data-slot="manage-models-scroll"] .scroll-view__thumb {
  opacity:1 !important;
  pointer-events:auto !important;
}
[data-slot="manage-models-scroll"] {
  overflow-x:hidden !important;
  overflow-y:auto !important;
  overscroll-behavior:contain;
  scrollbar-width:thin;
  scrollbar-color:var(--v2-border-border-strong,#888) transparent;
  scrollbar-gutter:stable;
}
[data-slot="manage-models-scroll"]::-webkit-scrollbar { width:10px; }
[data-slot="manage-models-scroll"]::-webkit-scrollbar-track { background:transparent; }
[data-slot="manage-models-scroll"]::-webkit-scrollbar-thumb {
  min-height:32px; border:2px solid transparent; border-radius:999px;
  background-clip:padding-box;
  background-color:var(--v2-border-border-strong,#888);
}
[data-component="settings-models-provider"][${COLLAPSED_ATTR}] > :not(.settings-models-group-header) {
  display:none !important;
}
[data-component="settings-models-provider"][${COLLAPSED_ATTR}] .settings-models-group-chevron svg {
  transform:rotate(-90deg);
}
[data-component="settings-models-provider"][${EMPTY_ATTR}] { display:none !important; }
`

function mountModelMenuUI(options) {
  const { window, document } = options
  let destroyed = false
  let timer
  const collapsed = new Map()

  const style = document.getElementById(STYLE_ID) ?? document.createElement("style")
  style.id = STYLE_ID
  if (style.textContent !== CSS) style.textContent = CSS
  if (!style.isConnected) document.head.append(style)

  function dialog() {
    return document.querySelector(".settings-manage-models-dialog")
  }

  function groupKey(section) {
    const title = section.querySelector(".settings-models-group-title")?.textContent?.trim()
    return title || ""
  }

  function onClick(event) {
    if (destroyed) return
    const trigger = event.target?.closest?.(".settings-models-group-trigger")
    if (!trigger || trigger.disabled) return
    const section = trigger.closest('[data-component="settings-models-provider"]')
    if (!section || !dialog()?.contains(section)) return
    const key = groupKey(section)
    if (!key) return
    if (trigger.getAttribute("aria-expanded") === "true") {
      if (collapsed.size >= MAX_REMEMBERED_GROUPS) collapsed.clear()
      collapsed.set(key, true)
    } else {
      collapsed.delete(key)
    }
  }

  function sync() {
    timer = undefined
    if (destroyed) return
    const current = dialog()
    if (!current) {
      collapsed.clear()
      return
    }
    const filtering = Boolean(current.querySelector('input[type="search"]')?.value)
    for (const section of current.querySelectorAll('[data-component="settings-models-provider"]')) {
      const trigger = section.querySelector(".settings-models-group-trigger")
      if (!filtering) {
        section.removeAttribute(COLLAPSED_ATTR)
        section.removeAttribute(EMPTY_ATTR)
        continue
      }
      // While searching Desktop expands every group. Preserve the user's collapsed
      // choices and remove header-only groups produced by an empty filtered result.
      const hasRows = [...section.children].some(
        (child) => !child.classList.contains("settings-models-group-header"),
      )
      section.toggleAttribute(EMPTY_ATTR, !hasRows)
      const isCollapsed = collapsed.has(groupKey(section))
      section.toggleAttribute(COLLAPSED_ATTR, isCollapsed)
      if (isCollapsed) trigger?.setAttribute("aria-expanded", "false")
    }
  }

  function schedule() {
    if (destroyed || timer !== undefined) return
    timer = window.setTimeout(sync, 0)
  }

  const observer =
    typeof window.MutationObserver === "function" ? new window.MutationObserver(schedule) : undefined
  if (observer && document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }
  document.addEventListener("click", onClick, true)
  window.addEventListener("pagehide", destroy, { once: true })
  sync()

  function destroy() {
    if (destroyed) return
    destroyed = true
    observer?.disconnect()
    document.removeEventListener("click", onClick, true)
    window.removeEventListener("pagehide", destroy)
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    collapsed.clear()
    for (const section of document.querySelectorAll('[data-component="settings-models-provider"]')) {
      section.removeAttribute(COLLAPSED_ATTR)
      section.removeAttribute(EMPTY_ATTR)
    }
  }

  return { destroy, sync }
}

module.exports = { CSS, mountModelMenuUI }
