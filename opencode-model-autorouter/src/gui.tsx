import { Command, Plugin, SettingsPage, Style, createLatest } from "@opencode/plugin/gui"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { ModelAutoRouterRpc } from "../rpc.ts"
import {
  KNOWN_ACCOUNT_PROVIDERS,
  accountCurrencies,
  catalogPrice,
  cbrConvert,
  formatBalance,
  formatLatency,
  formatPrice,
  formatSpeed,
  organizeModels,
  priceCurrency,
  type AccountInfo,
  type AccountThreshold,
  type CatalogModel,
  type Grouping,
  type ManualGroup,
  type PriceLimits,
  type RouterStatus,
  type Sorting,
  type Strategy,
} from "./catalog.ts"
import { manualGroupConfiguration, routerScope } from "./gui-state.ts"
import css from "./gui.css?inline"

interface ConfigurePatch {
  enabled?: boolean
  autoDiscover?: boolean
  strategy?: Strategy
  defaultGroup?: string
  resumeAfterFailover?: boolean
  askBeforeOverride?: boolean
  disabledModels?: string[]
  groups?: Record<string, { models: string[]; strategy?: Strategy }>
  cooldownMs?: number
  metricAlpha?: number
  rescanIntervalMs?: number
  accountThresholds?: Record<string, AccountThreshold>
  priceLimits?: Record<string, PriceLimits>
  cbrOrientation?: boolean
  providerSites?: Record<string, string>
  reset?: boolean
}

/** Per-currency price-bound drafts; empty strings mean "not set". */
interface PriceLimitDraft {
  inputMin: string
  inputMax: string
  outputMin: string
  outputMax: string
  action: "warn" | "exclude"
}

interface RouterOptions {
  signal: AbortSignal
  location?: { directory: string }
}

interface RouterClient {
  status(input: Record<string, never>, options: RouterOptions): Promise<RouterStatus>
  rescan(input: Record<string, never>, options: RouterOptions): Promise<RouterStatus>
  configure(input: ConfigurePatch, options: RouterOptions): Promise<RouterStatus>
  setAccountKey(
    input: { providerID: string; key: string },
    options: RouterOptions,
  ): Promise<{ stored: boolean; providerID: string }>
  clearAccountKey(
    input: { providerID: string },
    options: RouterOptions,
  ): Promise<{ cleared: boolean }>
  select(
    input: { sessionID: string; model: string },
    options: RouterOptions,
  ): Promise<{ selected: string }>
  resolveOverrideRequest(
    input: { sessionID: string; action: "keep" | "override" },
    options: RouterOptions,
  ): Promise<{ resolved: "keep" | "override"; model: string; pinned: boolean }>
  releaseManualSelection(
    input: { sessionID: string },
    options: RouterOptions,
  ): Promise<{ released: boolean }>
}

const strategies: Array<{ value: Strategy; label: string }> = [
  { value: "free-fastest", label: "Сначала бесплатные, затем быстрые" },
  { value: "fastest", label: "Самая быстрая" },
  { value: "cheapest", label: "Самая дешёвая" },
  { value: "manual", label: "Ручной приоритет" },
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, css)

    const RouterPage = () => {
      const [revision, setRevision] = createSignal(1)
      const [saving, setSaving] = createSignal(false)
      const [localError, setLocalError] = createSignal("")
      const [tab, setTab] = createSignal<"catalog" | "groups">("catalog")
      const [search, setSearch] = createSignal("")
      const [grouping, setGrouping] = createSignal<Grouping>("provider")
      const [sorting, setSorting] = createSignal<Sorting>("name")
      const [enabledOnly, setEnabledOnly] = createSignal(false)
      const [sessionKey, setSessionKey] = createSignal("")
      const [variants, setVariants] = createSignal<Record<string, string>>({})
      const [editorOpen, setEditorOpen] = createSignal(false)
      const [editorOriginal, setEditorOriginal] = createSignal("")
      const [editorName, setEditorName] = createSignal("")
      const [editorStrategy, setEditorStrategy] = createSignal<Strategy>("manual")
      const [editorModels, setEditorModels] = createSignal<string[]>([])
      const [groupSearch, setGroupSearch] = createSignal("")
      const [keyProvider, setKeyProvider] = createSignal("")
      const [keyDraft, setKeyDraft] = createSignal("")
      const [thresholdProvider, setThresholdProvider] = createSignal("")
      const [thresholdMin, setThresholdMin] = createSignal("")
      const [thresholdAction, setThresholdAction] = createSignal<"warn" | "exclude">("warn")
      const [priceDrafts, setPriceDrafts] = createSignal<Record<string, PriceLimitDraft>>({})
      const [siteDrafts, setSiteDrafts] = createSignal<Record<string, string>>({})

      const selectedSession = () => {
        const sessions = ctx.sessions.list()
        return (
          sessions.find((session) => session.key === sessionKey()) ??
          ctx.sessions.current() ??
          sessions[0]
        )
      }
      const scope = () => routerScope(selectedSession(), revision())
      const state = createLatest(scope, async (current, signal) => {
        if (!current.session || current.session.pending || !current.client || !current.location) {
          return undefined
        }
        const rpc = current.client.rpc(ModelAutoRouterRpc) as unknown as RouterClient
        return rpc.rescan({}, { signal, location: current.location })
      })
      const status = () => state.latest

      const refresh = () => setRevision((value) => value + 1)
      const timer = setInterval(() => {
        if (!saving() && !ctx.signal.aborted) refresh()
      }, 30_000)
      onCleanup(() => clearInterval(timer))

      const run = async (work: () => Promise<unknown>, success?: string): Promise<boolean> => {
        if (saving() || ctx.signal.aborted) return false
        setSaving(true)
        setLocalError("")
        try {
          await work()
          if (ctx.signal.aborted) return false
          refresh()
          if (success) ctx.toast.show({ title: success, variant: "success" })
          return true
        } catch (error) {
          if (!ctx.signal.aborted) {
            const message = errorMessage(error)
            setLocalError(message)
            ctx.toast.show({ title: "Настройки не сохранены", description: message, variant: "error" })
          }
          return false
        } finally {
          if (!ctx.signal.aborted) setSaving(false)
        }
      }

      const scoped = (
        work: (client: RouterClient, options: RouterOptions) => Promise<unknown>,
        success?: string,
      ): Promise<boolean> => {
        const current = routerScope(selectedSession(), 0)
        if (!current.session || current.session.pending || !current.client || !current.location) {
          setLocalError("Выберите открытую сессию с известной рабочей папкой")
          return Promise.resolve(false)
        }
        const rpc = current.client.rpc(ModelAutoRouterRpc) as unknown as RouterClient
        return run(
          () => work(rpc, { signal: ctx.signal, location: current.location! }),
          success,
        )
      }

      const configure = (patch: ConfigurePatch, success?: string) =>
        scoped((rpc, options) => rpc.configure(patch, options), success)

      const toggleModels = (models: CatalogModel[], enabled: boolean) => {
        const disabled = new Set(status()?.disabledModels ?? [])
        for (const model of models) {
          if (enabled) disabled.delete(model.model)
          else disabled.add(model.model)
        }
        void configure({ disabledModels: [...disabled].sort() })
      }

      const sections = createMemo(() =>
        organizeModels(status()?.models ?? [], {
          search: search(),
          grouping: grouping(),
          sorting: sorting(),
          enabledOnly: enabledOnly(),
        }),
      )
      const providers = createMemo(() => new Set(status()?.models.map((model) => model.providerID)).size)
      const enabledCount = createMemo(
        () => status()?.models.filter((model) => model.routingEnabled).length ?? 0,
      )
      const priceMax = createMemo(() => {
        const maxes: Record<string, number> = {}
        for (const model of status()?.models ?? []) {
          const unit = priceCurrency(model)
          const price = catalogPrice(model)
          if (!unit || !Number.isFinite(price)) continue
          maxes[unit] = Math.max(maxes[unit] ?? 1, price)
        }
        return maxes
      })
      const speedMax = createMemo(() =>
        Math.max(1, ...(status()?.models ?? []).map((model) => model.outputTokensPerSecond ?? 0)),
      )
      const accountsNote = createMemo(() => {
        const accounts = status()?.accounts ?? []
        if (accounts.length === 0) {
          return "Аккаунтные API провайдеров не найдены: цены не подставляются и не угадываются."
        }
        const parts = accounts.map((account) => `${account.providerID}: ${
          account.state === "live" ? "live" : account.state === "stale" ? "stale (кэш)" : "без аккаунтного API"
        }`)
        const stale = accounts.some((account) => account.state === "stale")
        return `${stale ? "Не все аккаунты удалось обновить" : "Аккаунты проверены"} — ${parts.join("; ")}.`
      })
      const defaultGroups = createMemo(() => [
        ...new Set([
          ...(status()?.groups.map((group) => group.name) ?? []),
          ...(status()?.manualGroups.map((group) => group.name) ?? []),
        ]),
      ])
      const selectModel = (model: CatalogModel) => {
        const session = selectedSession()
        if (!session || session.pending) return
        const variant = variants()[model.model]
        const ref = `${model.model}${variant ? `#${variant}` : ""}`
        void scoped(
          (rpc, options) => rpc.select({ sessionID: session.id, model: ref }, options),
          `Выбрана модель ${ref}`,
        )
      }

      const saveAccountKey = async () => {
        const providerID = keyProvider()
        const key = keyDraft()
        if (!providerID || !key.trim()) return
        const saved = await scoped(
          (rpc, options) => rpc.setAccountKey({ providerID, key }, options),
          `Ключ ${providerID} сохранён в зашифрованном хранилище плагина`,
        )
        if (saved) {
          setKeyProvider("")
          setKeyDraft("")
        }
      }

      const clearAccountKey = async (providerID: string) => {
        if (!(await ctx.dialogs.confirm({
          title: `Удалить ключ плагина для ${providerID}?`,
          description: "Роутер вернётся к ключу из connections OpenCode, если он там есть. Тарифы и баланс обновятся при следующем сканировании.",
          confirm: "Удалить",
          danger: true,
        }))) return
        await scoped(
          (rpc, options) => rpc.clearAccountKey({ providerID }, options),
          `Ключ плагина для ${providerID} удалён`,
        )
      }

      const orientationCurrencies = createMemo(() =>
        status()?.cbr ? accountCurrencies(status()!) : [],
      )
      const orientationTitle = () =>
        `Приблизительно по курсу ЦБ РФ на ${status()?.cbr?.date ?? "—"}; не используется для маршрутизации`
      const orientation = (amount: number | undefined, from: string | undefined) => {
        const rates = status()?.cbr?.rates
        if (!rates || amount === undefined) return []
        return orientationCurrencies()
          .filter((unit) => unit !== from)
          .map((unit) => ({ unit, value: cbrConvert(rates, amount, from, unit) }))
          .filter((item): item is { unit: string; value: number } => item.value !== undefined)
      }
      const priceOrientation = (model: CatalogModel) => {
        const price = catalogPrice(model)
        return Number.isFinite(price) ? orientation(price, priceCurrency(model)) : []
      }
      const thresholdCurrencyLabel = () => {
        const account = status()?.accounts.find((item) => item.providerID === thresholdProvider())
        return account?.balanceCurrency ?? "валюта аккаунта"
      }
      const thresholdSummary = (account: AccountInfo) => {
        const threshold = status()?.accountThresholds?.[account.providerID]
        if (!threshold) return ""
        const parts: string[] = []
        if (threshold.minBalance !== undefined) {
          parts.push(`мин. остаток ${formatBalance(threshold.minBalance, account.balanceCurrency)}`)
        }
        parts.push(threshold.action === "exclude" ? "исключать из роутинга" : "только предупреждать")
        return parts.join(" · ")
      }
      const openThresholdForm = (account: AccountInfo) => {
        const existing = status()?.accountThresholds?.[account.providerID]
        setThresholdProvider(account.providerID)
        setThresholdMin(existing?.minBalance !== undefined ? String(existing.minBalance) : "")
        setThresholdAction(existing?.action === "exclude" ? "exclude" : "warn")
      }
      const saveThreshold = async () => {
        const providerID = thresholdProvider()
        if (!providerID) return
        const minValue = thresholdMin().trim() === "" ? undefined : Number(thresholdMin())
        if (minValue !== undefined && (!Number.isFinite(minValue) || minValue < 0)) {
          setLocalError("Минимальный остаток должен быть неотрицательным числом")
          return
        }
        const thresholds: Record<string, AccountThreshold> = { ...(status()?.accountThresholds ?? {}) }
        if (minValue === undefined) delete thresholds[providerID]
        else thresholds[providerID] = { minBalance: minValue, action: thresholdAction() }
        const saved = await configure(
          { accountThresholds: thresholds },
          minValue === undefined
            ? `Пороги ${providerID} удалены`
            : `Пороги ${providerID} сохранены`,
        )
        if (saved) setThresholdProvider("")
      }

      /** Currencies with confirmed account prices, plus any already configured bounds. */
      const limitCurrencies = createMemo(() => {
        const current = status()
        if (!current) return []
        return [
          ...new Set([
            ...Object.keys(current.priceLimits ?? {}),
            ...accountCurrencies(current),
          ]),
        ].sort()
      })
      const priceDraft = (currency: string): PriceLimitDraft => {
        const draft = priceDrafts()[currency]
        if (draft) return draft
        const bound = status()?.priceLimits?.[currency]
        return {
          inputMin: bound?.inputMin !== undefined ? String(bound.inputMin) : "",
          inputMax: bound?.inputMax !== undefined ? String(bound.inputMax) : "",
          outputMin: bound?.outputMin !== undefined ? String(bound.outputMin) : "",
          outputMax: bound?.outputMax !== undefined ? String(bound.outputMax) : "",
          action: bound?.action === "exclude" ? "exclude" : "warn",
        }
      }
      const setPriceField = (
        currency: string,
        field: keyof PriceLimitDraft,
        value: string,
      ) => {
        setPriceDrafts({ ...priceDrafts(), [currency]: { ...priceDraft(currency), [field]: value } })
      }
      const savePriceLimits = async (currency: string) => {
        const draft = priceDraft(currency)
        const bound: PriceLimits = { action: draft.action }
        let cleared = true
        for (const key of ["inputMin", "inputMax", "outputMin", "outputMax"] as const) {
          const text = draft[key].trim()
          if (text === "") continue
          const value = Number(text)
          if (!Number.isFinite(value) || value < 0) {
            setLocalError("Границы цены должны быть неотрицательными числами")
            return
          }
          bound[key] = value
          cleared = false
        }
        const limits: Record<string, PriceLimits> = { ...(status()?.priceLimits ?? {}) }
        if (cleared) delete limits[currency]
        else limits[currency] = bound
        const saved = await configure(
          { priceLimits: limits },
          cleared
            ? `Границы цены для ${currency} удалены`
            : `Границы цены для ${currency} сохранены`,
        )
        if (saved) {
          setPriceDrafts((previous) => {
            const next = { ...previous }
            delete next[currency]
            return next
          })
        }
      }

      /** Providers offered for public price discovery: configured sites plus every catalog provider. */
      const publicProviders = createMemo(() => {
        const current = status()
        if (!current) return []
        return [
          ...new Set([
            ...Object.keys(current.providerSites ?? {}),
            ...current.models.map((model) => model.providerID),
          ]),
        ].sort()
      })
      const siteDraft = (providerID: string): string =>
        siteDrafts()[providerID] ?? status()?.providerSites?.[providerID] ?? ""
      const publicInfo = (providerID: string) =>
        status()?.publicPricing.find((item) => item.providerID === providerID)
      const saveSite = async (providerID: string) => {
        const text = siteDraft(providerID).trim()
        const sites: Record<string, string> = { ...(status()?.providerSites ?? {}) }
        if (text === "") {
          delete sites[providerID]
        } else {
          let url: URL
          try {
            url = new URL(text)
          } catch {
            setLocalError("Адрес должен быть полным URL, например https://provider.example")
            return
          }
          const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
            setLocalError("Допустимы только https-адреса (http — для localhost)")
            return
          }
          sites[providerID] = text
        }
        const saved = await configure(
          { providerSites: sites },
          text === ""
            ? `Адрес ${providerID} удалён`
            : `Адрес ${providerID} сохранён: публичные цены обновятся при следующем сканировании`,
        )
        if (saved) {
          setSiteDrafts((previous) => {
            const next = { ...previous }
            delete next[providerID]
            return next
          })
        }
      }

      const editGroup = (group?: ManualGroup) => {
        setEditorOriginal(group?.name ?? "")
        setEditorName(group?.name ?? `route-${(status()?.manualGroups.length ?? 0) + 1}`)
        setEditorStrategy(group?.strategy ?? "manual")
        setEditorModels([...(group?.models ?? [])])
        setGroupSearch("")
        setEditorOpen(true)
      }

      const moveEditorModel = (index: number, delta: number) => {
        const models = [...editorModels()]
        const target = index + delta
        if (target < 0 || target >= models.length) return
        const [model] = models.splice(index, 1)
        models.splice(target, 0, model)
        setEditorModels(models)
      }

      const editorChoices = createMemo(() => {
        const choices: Array<{ ref: string; name: string; detail: string; enabled: boolean }> = []
        for (const model of status()?.models ?? []) {
          choices.push({
            ref: model.model,
            name: model.name ?? model.id,
            detail: model.model,
            enabled: model.routingEnabled,
          })
          for (const variant of model.variants) {
            choices.push({
              ref: `${model.model}#${variant}`,
              name: `${model.name ?? model.id} · ${variant}`,
              detail: `${model.model}#${variant}`,
              enabled: model.routingEnabled,
            })
          }
        }
        const known = new Set(choices.map((choice) => choice.ref))
        for (const ref of editorModels()) {
          if (!known.has(ref)) choices.push({ ref, name: ref, detail: "Сейчас недоступна", enabled: false })
        }
        const query = groupSearch().trim().toLocaleLowerCase()
        return choices.filter((choice) =>
          !query
            ? true
            : `${choice.name} ${choice.detail}`.toLocaleLowerCase().includes(query),
        )
      })

      const saveGroup = async () => {
        const current = status()
        if (!current) return
        const name = editorName().trim()
        if (!name) {
          setLocalError("Введите имя группы")
          return
        }
        if (current.manualGroups.some((group) => group.name === name && group.name !== editorOriginal())) {
          setLocalError("Группа с таким именем уже существует")
          return
        }
        if (editorModels().length === 0) {
          setLocalError("Добавьте в группу хотя бы одну модель")
          return
        }
        const patch: ConfigurePatch = manualGroupConfiguration(current, editorOriginal(), {
          name,
          models: editorModels(),
          strategy: editorStrategy(),
        })
        if (await configure(patch, `Группа ${name} сохранена`)) setEditorOpen(false)
      }

      const removeGroup = async (group: ManualGroup) => {
        if (!(await ctx.dialogs.confirm({
          title: `Удалить группу ${group.name}?`,
          description: "Сами модели и настройки провайдеров не изменятся.",
          confirm: "Удалить",
          danger: true,
        }))) return
        const groups = Object.fromEntries(
          (status()?.manualGroups ?? [])
            .filter((item) => item.name !== group.name)
            .map((item) => [item.name, { models: item.models, strategy: item.strategy }]),
        )
        const patch: ConfigurePatch = { groups }
        if (status()?.defaultGroup === group.name) patch.defaultGroup = ""
        await configure(patch, `Группа ${group.name} удалена`)
      }

      const ModelRow = (props: { model: CatalogModel }) => {
        const model = props.model
        const tier = model.cost?.[0]
        const unit = priceCurrency(model)
        const priceRatio = unit ? Math.min(100, (catalogPrice(model) / (priceMax()[unit] ?? 1)) * 100) : 0
        const speedRatio = Math.min(100, ((model.outputTokensPerSecond ?? 0) / speedMax()) * 100)
        const priceTitle = model.actualCostPerMillionUSD !== undefined
          ? `Фактическая стоимость: ${formatPrice(model.actualCostPerMillionUSD, "USD")} / 1M сгенерированных токенов (данные OpenCode, USD)`
          : model.priceState === "live"
            ? "Аккаунтный тариф провайдера; первый тариф"
            : model.priceState === "stale"
              ? "Кэш аккаунтного тарифа: обновление не удалось; первый тариф"
              : model.priceState === "public"
                ? "Публичный тариф с сайта провайдера (без входа); первый тариф. Аккаунтный тариф точнее — задайте ключ, если он доступен"
                : model.priceState === "public-stale"
                  ? "Кэш публичного тарифа: обновить не удалось; первый тариф"
                  : "Ни аккаунтный, ни публичный тариф для этой модели не подтверждён"
        return (
          <div class="mar-model-row" data-disabled={!model.routingEnabled}>
            <div class="mar-model-main">
              <ctx.ui.Switch
                checked={model.routingEnabled}
                disabled={saving() || !model.enabled}
                hideLabel
                label={`Использовать ${model.model} в роутинге`}
                onChange={(enabled) => toggleModels([model], enabled)}
              />
              <div class="mar-model-copy">
                <div class="mar-model-title">
                  <span>{model.name ?? model.id}</span>
                  <Show when={model.free}><span class="mar-badge" data-tone="free">free</span></Show>
                  <Show when={!model.enabled}><span class="mar-badge" data-tone="warning">выключена в OpenCode</span></Show>
                  <Show when={model.enabled && !model.routingEnabled}><span class="mar-badge">не роутится</span></Show>
                  <Show when={model.cooldownMs > 0}>
                    <span class="mar-badge" data-tone="warning">cooldown {Math.ceil(model.cooldownMs / 1000)} с</span>
                  </Show>
                  <Show when={model.priceLimitBreached}>
                    <span class="mar-badge" data-tone="warning" title="Подтверждённый аккаунтный тариф вне заданных границ цены">вне границ цены</span>
                  </Show>
                  <Show when={model.thresholdExcluded}>
                    <span class="mar-badge" data-tone="warning" title="Исключена из роутинга порогом; вернётся автоматически, когда значение вернётся в норму">исключена порогом</span>
                  </Show>
                </div>
                <div class="mar-model-id">{model.model}</div>
                <Show when={model.groups.length > 0}>
                  <div class="mar-model-groups">{model.groups.join(" · ")}</div>
                </Show>
              </div>
            </div>
            <div class="mar-metric" title={priceTitle}>
              <span class="mar-metric-value">{formatPrice(tier?.input, model.costCurrency)} / {formatPrice(tier?.output, model.costCurrency)}</span>
              <span class="mar-metric-label">{model.costCurrency ?? "—"} / 1M input · output{model.priceState === "live" ? " · live" : model.priceState === "stale" ? " · stale" : model.priceState === "public" ? " · public" : model.priceState === "public-stale" ? " · public stale" : ""}</span>
              <Show when={priceOrientation(model).length > 0}>
                <span class="mar-orientation" title={orientationTitle()}>
                  ≈ {priceOrientation(model).map((item) => formatPrice(item.value, item.unit)).join(" · ")}
                </span>
              </Show>
              <div class="mar-meter" aria-hidden="true"><div class="mar-meter-fill" style={{ width: `${priceRatio}%` }} /></div>
            </div>
            <div class="mar-metric">
              <span class="mar-metric-value">{formatSpeed(model.outputTokensPerSecond)}</span>
              <span class="mar-metric-label">генерация · {model.successes} успешн.</span>
              <div class="mar-meter" aria-hidden="true"><div class="mar-meter-fill" data-tone="speed" style={{ width: `${speedRatio}%` }} /></div>
            </div>
            <div class="mar-metric" title={`Latency: ${formatLatency(model.latencyMs)} · ошибок: ${model.failures}`}>
              <span class="mar-metric-value">{formatLatency(model.ttfbMs)}</span>
              <span class="mar-metric-label">TTFB · {formatLatency(model.latencyMs)} шаг</span>
            </div>
            <div class="mar-model-actions">
              <Show when={model.variants.length > 0}>
                <select
                  class="mar-select"
                  aria-label={`Variant для ${model.model}`}
                  value={variants()[model.model] ?? ""}
                  disabled={saving()}
                  onChange={(event) => setVariants({ ...variants(), [model.model]: event.currentTarget.value })}
                >
                  <option value="">default</option>
                  <For each={model.variants}>{(variant) => <option value={variant}>{variant}</option>}</For>
                </select>
              </Show>
              <ctx.ui.Button
                size="small"
                disabled={saving() || !model.routingEnabled || !selectedSession() || selectedSession()?.pending}
                onClick={() => selectModel(model)}
              >
                Выбрать
              </ctx.ui.Button>
            </div>
          </div>
        )
      }

      return (
        <div class="mar-page">
          <div class="mar-heading">
            <div>
              <h2>Model Autorouter</h2>
              <p class="mar-subtitle">Все chat-модели подключённых провайдеров: реальные переключатели роутинга, аккаунтные тарифы и баланс из API провайдеров, измеренная скорость. Настройки сохраняются на сервере OpenCode.</p>
            </div>
            <div class="mar-actions">
              <ctx.ui.Button
                icon="outline-rotate-clockwise"
                busy={state.loading || saving()}
                onClick={() => void scoped((rpc, options) => rpc.rescan({}, options), "Каталог обновлён")}
              >
                Сканировать
              </ctx.ui.Button>
            </div>
          </div>

          <Show when={localError() || state.error}>
            <div class="mar-error" role="alert">{localError() || errorMessage(state.error)}</div>
          </Show>
          <Show when={!status() && state.loading}>
            <div class="mar-loading"><ctx.ui.Loader size="large" /> Загрузка каталога…</div>
          </Show>

          <Show when={status()}>
            <div class="mar-summary">
              <div class="mar-stat"><span class="mar-stat-value">{status()!.modelsDiscovered}</span><span class="mar-stat-label">chat-моделей</span></div>
              <div class="mar-stat"><span class="mar-stat-value">{enabledCount()}</span><span class="mar-stat-label">разрешено в роутинге</span></div>
              <div class="mar-stat"><span class="mar-stat-value">{providers()}</span><span class="mar-stat-label">провайдеров</span></div>
              <div class="mar-stat"><span class="mar-stat-value">{status()!.groups.length}</span><span class="mar-stat-label">активных route-групп</span></div>
            </div>

            <section class="mar-panel">
              <div class="mar-panel-body">
                <h3>Аккаунты провайдеров</h3>
                <p class="mar-help">Баланс и тарифы запрашиваются серверной частью из аккаунтных API провайдеров. По умолчанию используется ключ из connections OpenCode; дополнительно можно сохранить аккаунтный ключ в зашифрованном хранилище плагина — он не передаётся OpenCode, не отображается в GUI и не попадает в статус.</p>
                <div class="mar-account-list">
                  <For each={status()!.accounts}>{(account) => (
                    <div class="mar-account">
                      <span class="mar-account-name">{account.providerID}</span>
                      <span class="mar-badge" data-tone={account.state === "live" ? "free" : account.state === "stale" ? "warning" : undefined}>
                        {account.state === "live" ? "live" : account.state === "stale" ? "stale" : "unsupported"}
                      </span>
                      <Show when={account.lowBalance}>
                        <span class="mar-badge" data-tone="warning" title="Остаток средств ниже заданного минимума">ниже минимума</span>
                      </Show>
                      <Show when={account.keySource === "plugin"}>
                        <span class="mar-badge" data-tone="free" title="Аккаунтный ключ сохранён в зашифрованном хранилище плагина">ключ плагина</span>
                      </Show>
                      <Show when={account.keySource === "opencode"}>
                        <span class="mar-badge" title="Ключ берётся из connections OpenCode">ключ OpenCode</span>
                      </Show>
                      <span class="mar-account-balance" title={account.balanceSupported ? "Остаток средств из аккаунтного API" : "Аккаунтный API баланса не подтверждён"}>
                        {account.balanceSupported ? formatBalance(account.balance, account.balanceCurrency) : "—"}
                      </span>
                      <span class="mar-muted">
                        {account.pricingSupported ? `${account.matchedModels} моделей с ценой` : "API тарифов не подтверждён"}
                      </span>
                      <Show when={account.updatedAt}>
                        <span class="mar-muted">{new Date(account.updatedAt!).toLocaleTimeString("ru-RU")}</span>
                      </Show>
                      <Show when={thresholdSummary(account)}>
                        <span class="mar-account-note" title="Пороги мониторинга в валюте аккаунта">порог: {thresholdSummary(account)}</span>
                      </Show>
                      <Show when={orientation(account.balance, account.balanceCurrency).length > 0}>
                        <span class="mar-account-note" title={orientationTitle()}>
                          ≈ {orientation(account.balance, account.balanceCurrency).map((item) => formatBalance(item.value, item.unit)).join(" · ")}
                        </span>
                      </Show>
                      <Show when={account.state !== "unsupported" || account.providerID in KNOWN_ACCOUNT_PROVIDERS}>
                        <div class="mar-account-actions">
                          <Show when={account.state !== "unsupported"}>
                            <ctx.ui.Button
                              size="small"
                              variant="ghost"
                              disabled={saving()}
                              onClick={() => openThresholdForm(account)}
                            >
                              {status()?.accountThresholds?.[account.providerID] ? "Изменить пороги" : "Пороги"}
                            </ctx.ui.Button>
                          </Show>
                          <ctx.ui.Button
                            size="small"
                            variant="ghost"
                            disabled={saving()}
                            onClick={() => { setKeyProvider(account.providerID); setKeyDraft("") }}
                          >
                            {account.pluginKey ? "Заменить ключ" : "Аккаунтные цены и баланс"}
                          </ctx.ui.Button>
                          <Show when={account.pluginKey}>
                            <ctx.ui.Button size="small" variant="danger" disabled={saving()} onClick={() => void clearAccountKey(account.providerID)}>Удалить ключ</ctx.ui.Button>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}</For>
                  <Show when={status()!.accounts.length === 0}>
                    <div class="mar-empty">Подключённые провайдеры не предоставляют подтверждённый аккаунтный API: цены и баланс не показываются.</div>
                  </Show>
                </div>
                <Show when={keyProvider()}>
                  <form class="mar-key-form" onSubmit={(event) => { event.preventDefault(); void saveAccountKey() }}>
                    <ctx.ui.TextInput
                      type="password"
                      class="mar-key-input"
                      label={`Аккаунтный ключ ${keyProvider()}`}
                      placeholder="Аккаунтный ключ для аккаунтного API"
                      value={keyDraft()}
                      onInput={setKeyDraft}
                      onSubmit={() => void saveAccountKey()}
                      autofocus
                    />
                    <div class="mar-actions">
                      <ctx.ui.Button variant="contrast" size="small" busy={saving()} onClick={() => void saveAccountKey()}>Сохранить ключ</ctx.ui.Button>
                      <ctx.ui.Button variant="ghost" size="small" disabled={saving()} onClick={() => { setKeyProvider(""); setKeyDraft("") }}>Отмена</ctx.ui.Button>
                    </div>
                    <p class="mar-help">Ключ шифруется AES-256-GCM в хранилище плагина и отправляется только в аккаунтный API {keyProvider()}. Он не передаётся OpenCode и не отображается обратно.</p>
                  </form>
                </Show>
                <Show when={thresholdProvider()}>
                  <form class="mar-key-form mar-threshold-form" onSubmit={(event) => { event.preventDefault(); void saveThreshold() }}>
                    <label class="mar-threshold-field">
                      <span>Минимальный остаток ({thresholdCurrencyLabel()})</span>
                      <input class="mar-number" type="number" min="0" step="any" placeholder="не задан" value={thresholdMin()} onInput={(event) => setThresholdMin(event.currentTarget.value)} />
                    </label>
                    <label class="mar-threshold-field">
                      <span>Действие при выходе за порог</span>
                      <select class="mar-select" value={thresholdAction()} onChange={(event) => setThresholdAction(event.currentTarget.value as "warn" | "exclude")}>
                        <option value="warn">Только предупреждать</option>
                        <option value="exclude">Предупреждать и исключать из роутинга</option>
                      </select>
                    </label>
                    <div class="mar-actions">
                      <ctx.ui.Button variant="contrast" size="small" busy={saving()} onClick={() => void saveThreshold()}>Сохранить пороги</ctx.ui.Button>
                      <ctx.ui.Button variant="ghost" size="small" disabled={saving()} onClick={() => setThresholdProvider("")}>Отмена</ctx.ui.Button>
                    </div>
                    <p class="mar-help">Порог остатка задаётся в валюте аккаунта и проверяется при каждом обновлении. «Исключать» убирает модели провайдера из выбора роутера; исключение снимается автоматически, как только остаток вернётся в норму. Границы цены задаются отдельно — сразу для всех моделей в валюте цены.</p>
                  </form>
                </Show>
                <Show when={status()!.cbrOrientation}>
                  <p class="mar-help">
                    {status()!.cbr
                      ? `Ориентировка «≈» показана по курсу ЦБ РФ на ${status()!.cbr!.date}${status()!.cbr!.stale ? " (курсы устарели: обновить не удалось)" : ""}. Значения приблизительные и в маршрутизации не участвуют.`
                      : "Курс ЦБ РФ ещё не загружен: ориентировка появится после первого успешного запроса к публичному API ЦБ РФ."}
                  </p>
                </Show>
              </div>
            </section>

            <section class="mar-panel">
              <div class="mar-panel-body">
                <h3>Публичные цены без входа</h3>
                <p class="mar-help">Укажите адрес заглавной страницы поставщика (например https://openrouter.ai) — роутер сам найдёт публичный список моделей с ценами и будет показывать их без входа в аккаунт. Запросы к этим адресам идут строго без ключей и cookies; цены в нераспознанном формате не отображаются и не выдумываются. Аккаунтный тариф всегда приоритетнее публичного; для точного мониторинга расходов можно задать аккаунтный ключ.</p>
                <For each={publicProviders()}>{(providerID) => (
                  <div class="mar-site-row">
                    <span class="mar-price-limit-currency">{providerID}</span>
                    <Show when={publicInfo(providerID)}>
                      <span
                        class="mar-badge"
                        data-tone={publicInfo(providerID)!.state === "live" ? "free" : "warning"}
                        title={publicInfo(providerID)!.origin}
                      >
                        {publicInfo(providerID)!.state === "live"
                          ? `публичный тариф · ${publicInfo(providerID)!.matchedModels} моделей`
                          : "публичный тариф (кэш)"}
                      </span>
                    </Show>
                    <input
                      class="mar-site-input"
                      type="url"
                      placeholder="https://provider.example — адрес заглавной страницы"
                      value={siteDraft(providerID)}
                      disabled={saving()}
                      onInput={(event) => setSiteDrafts({ ...siteDrafts(), [providerID]: event.currentTarget.value })}
                    />
                    <ctx.ui.Button
                      size="small"
                      variant="contrast"
                      busy={saving()}
                      onClick={() => void saveSite(providerID)}
                    >
                      {siteDraft(providerID).trim() === "" && status()?.providerSites?.[providerID] ? "Удалить адрес" : "Сохранить адрес"}
                    </ctx.ui.Button>
                    <Show when={!status()?.accounts.find((account) => account.providerID === providerID)?.pluginKey}>
                      <ctx.ui.Button
                        size="small"
                        variant="ghost"
                        disabled={saving()}
                        onClick={() => { setKeyProvider(providerID); setKeyDraft("") }}
                      >
                        Аккаунтные цены и баланс
                      </ctx.ui.Button>
                    </Show>
                  </div>
                )}</For>
              </div>
            </section>

            <section class="mar-panel">
              <div class="mar-panel-body">
                <h3>Границы цены для всех моделей</h3>
                <p class="mar-help">Границы задаются в валюте аккаунтной цены и применяются сразу ко всем моделям всех провайдеров с подтверждённым аккаунтным тарифом в этой валюте (цена за 1M токенов, input и output первого тарифа). Значения в разных валютах никогда не смешиваются. «Исключать из роутинга» убирает модели вне границ из выбора роутера — переключение на допустимые модели происходит автоматически при следующем выборе; исключение снимается само, когда цена вернётся в границы.</p>
                <Show when={limitCurrencies().length === 0}>
                  <div class="mar-empty">Аккаунтные валюты цен ещё не подтверждены: границы можно задать, когда провайдеры вернут тарифы.</div>
                </Show>
                <For each={limitCurrencies()}>{(currency) => (
                  <div class="mar-price-limit-row">
                    <span class="mar-price-limit-currency">{currency}</span>
                    <label class="mar-threshold-field">
                      <span>input ≤</span>
                      <input class="mar-number" type="number" min="0" step="any" placeholder="нет" value={priceDraft(currency).inputMax} onInput={(event) => setPriceField(currency, "inputMax", event.currentTarget.value)} />
                    </label>
                    <label class="mar-threshold-field">
                      <span>output ≤</span>
                      <input class="mar-number" type="number" min="0" step="any" placeholder="нет" value={priceDraft(currency).outputMax} onInput={(event) => setPriceField(currency, "outputMax", event.currentTarget.value)} />
                    </label>
                    <label class="mar-threshold-field">
                      <span>input ≥</span>
                      <input class="mar-number" type="number" min="0" step="any" placeholder="нет" value={priceDraft(currency).inputMin} onInput={(event) => setPriceField(currency, "inputMin", event.currentTarget.value)} />
                    </label>
                    <label class="mar-threshold-field">
                      <span>output ≥</span>
                      <input class="mar-number" type="number" min="0" step="any" placeholder="нет" value={priceDraft(currency).outputMin} onInput={(event) => setPriceField(currency, "outputMin", event.currentTarget.value)} />
                    </label>
                    <label class="mar-threshold-field">
                      <span>Действие</span>
                      <select class="mar-select" value={priceDraft(currency).action} onChange={(event) => setPriceField(currency, "action", event.currentTarget.value)}>
                        <option value="warn">Только предупреждать</option>
                        <option value="exclude">Предупреждать и исключать из роутинга</option>
                      </select>
                    </label>
                    <ctx.ui.Button variant="contrast" size="small" busy={saving()} onClick={() => void savePriceLimits(currency)}>Сохранить</ctx.ui.Button>
                  </div>
                )}</For>
              </div>
            </section>

            <Show when={status()!.overrideRequests.length > 0 || status()!.pinnedModels.length > 0}>
              <section class="mar-panel">
                <div class="mar-panel-body">
                  <h3>Защита ручного выбора</h3>
                  <p class="mar-help">Роутер не переключает молча модель, выбранную вручную. Подтвердите предложение или снимите закрепление — маршрутизация возобновится автоматически.</p>
                  <div class="mar-account-list">
                    <For each={status()!.overrideRequests}>{(request) => (
                      <div class="mar-account">
                        <span class="mar-account-name">{request.sessionID.slice(0, 20)}</span>
                        <span class="mar-badge" data-tone="warning">вопрос</span>
                        <span class="mar-muted">Вручную: {request.current}</span>
                        <span class="mar-muted">Предложение: {request.proposed}</span>
                        <span class="mar-muted">Группа: {request.group}</span>
                        <div class="mar-account-actions">
                          <ctx.ui.Button
                            size="small"
                            variant="ghost"
                            disabled={saving()}
                            onClick={() => void scoped((rpc, options) => rpc.resolveOverrideRequest({ sessionID: request.sessionID, action: "keep" }, options), `Оставлена ${request.current}`)}
                          >
                            Оставить {request.current}
                          </ctx.ui.Button>
                          <ctx.ui.Button
                            size="small"
                            variant="contrast"
                            disabled={saving()}
                            onClick={() => void scoped((rpc, options) => rpc.resolveOverrideRequest({ sessionID: request.sessionID, action: "override" }, options), `Переключено на ${request.proposed}`)}
                          >
                            Переключить на {request.proposed}
                          </ctx.ui.Button>
                        </div>
                      </div>
                    )}</For>
                    <For each={status()!.pinnedModels}>{(pinned) => (
                      <div class="mar-account">
                        <span class="mar-account-name">{pinned.sessionID.slice(0, 20)}</span>
                        <span class="mar-badge" data-tone="free">закреплено</span>
                        <span class="mar-muted">{pinned.model}</span>
                        <div class="mar-account-actions">
                          <ctx.ui.Button
                            size="small"
                            variant="ghost"
                            disabled={saving()}
                            onClick={() => void scoped((rpc, options) => rpc.releaseManualSelection({ sessionID: pinned.sessionID }, options), "Закрепление снято — маршрутизация снова активна")}
                          >
                            Снять закрепление
                          </ctx.ui.Button>
                        </div>
                      </div>
                    )}</For>
                  </div>
                </div>
              </section>
            </Show>

            <section class="mar-panel">
              <div class="mar-panel-body">
                <div class="mar-settings-grid">
                  <div class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Автоматическая маршрутизация</span><span class="mar-setting-description">Выбор модели и failover; RPC настроек остаётся доступным</span></div>
                    <ctx.ui.Switch checked={status()!.enabled} disabled={saving()} hideLabel label="Включить автоматическую маршрутизацию" onChange={(enabled) => void configure({ enabled })} />
                  </div>
                  <div class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Автоматические группы</span><span class="mar-setting-description">Одинаковые model ID у разных провайдеров</span></div>
                    <ctx.ui.Switch checked={status()!.autoDiscover} disabled={saving()} hideLabel label="Создавать автоматические группы" onChange={(autoDiscover) => void configure({ autoDiscover })} />
                  </div>
                  <div class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Продолжение после лимита</span><span class="mar-setting-description">Synthetic-продолжение без повторной отправки prompt</span></div>
                    <ctx.ui.Switch checked={status()!.resumeAfterFailover} disabled={saving()} hideLabel label="Автоматически продолжать после failover" onChange={(resumeAfterFailover) => void configure({ resumeAfterFailover })} />
                  </div>
                  <div class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Защита ручного выбора модели</span><span class="mar-setting-description">Если модель выставлена не роутером, он спросит перед переключением и не перехватит молча</span></div>
                    <ctx.ui.Switch checked={status()!.askBeforeOverride} disabled={saving()} hideLabel label="Спрашивать перед перехватом ручного выбора" onChange={(askBeforeOverride) => void configure({ askBeforeOverride })} />
                  </div>
                  <div class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Ориентировка по курсу ЦБ РФ</span><span class="mar-setting-description">Приблизительные эквиваленты балансов и цен во всех валютах аккаунтов; на маршрутизацию не влияет</span></div>
                    <ctx.ui.Switch checked={status()!.cbrOrientation} disabled={saving()} hideLabel label="Показывать приблизительные эквиваленты по курсу ЦБ РФ" onChange={(cbrOrientation) => void configure({ cbrOrientation })} />
                  </div>
                  <label class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Стратегия по умолчанию</span><span class="mar-setting-description">Используется группами без собственной стратегии</span></div>
                    <select class="mar-select" value={status()!.strategy} disabled={saving()} onChange={(event) => void configure({ strategy: event.currentTarget.value as Strategy })}>
                      <For each={strategies}>{(item) => <option value={item.value}>{item.label}</option>}</For>
                    </select>
                  </label>
                  <label class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Группа для каждого prompt</span><span class="mar-setting-description">По умолчанию группа определяется текущей моделью</span></div>
                    <select class="mar-select" value={status()!.defaultGroup ?? ""} disabled={saving()} onChange={(event) => void configure({ defaultGroup: event.currentTarget.value })}>
                      <option value="">Автоматически</option>
                      <For each={defaultGroups()}>{(name) => <option value={name}>{name}</option>}</For>
                    </select>
                  </label>
                  <label class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Сессия для ручного выбора</span><span class="mar-setting-description">Кнопка «Выбрать» не отправляет prompt</span></div>
                    <select class="mar-select" value={selectedSession()?.key ?? ""} disabled={saving() || ctx.sessions.list().length === 0} onChange={(event) => setSessionKey(event.currentTarget.value)}>
                      <Show when={ctx.sessions.list().length === 0}><option value="">Нет открытых сессий</option></Show>
                      <For each={ctx.sessions.list()}>{(session) => <option value={session.key}>{session.id.slice(0, 20)} · {session.server.name}</option>}</For>
                    </select>
                  </label>
                  <label class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Cooldown, секунды</span><span class="mar-setting-description">Используется, если провайдер не вернул Retry-After</span></div>
                    <input class="mar-number" type="number" min="1" max="86400" step="1" value={status()!.cooldownMs / 1000} disabled={saving()} onChange={(event) => { const value = Number(event.currentTarget.value); if (value >= 1) void configure({ cooldownMs: value * 1000 }) }} />
                  </label>
                  <label class="mar-setting">
                    <div class="mar-setting-copy"><span class="mar-setting-title">Сканирование, секунды</span><span class="mar-setting-description">Периодическое обновление каталога моделей</span></div>
                    <input class="mar-number" type="number" min="5" max="3600" step="5" value={status()!.rescanIntervalMs / 1000} disabled={saving()} onChange={(event) => { const value = Number(event.currentTarget.value); if (value >= 5) void configure({ rescanIntervalMs: value * 1000 }) }} />
                  </label>
                </div>
              </div>
            </section>

            <div class="mar-tabs" role="tablist">
              <button class="mar-tab" role="tab" aria-selected={tab() === "catalog"} data-active={tab() === "catalog"} onClick={() => setTab("catalog")}>Каталог и сравнение</button>
              <button class="mar-tab" role="tab" aria-selected={tab() === "groups"} data-active={tab() === "groups"} onClick={() => setTab("groups")}>Ручные группы · {status()!.manualGroups.length}</button>
            </div>

            <Show when={tab() === "catalog"}>
              <div class="mar-toolbar">
                <ctx.ui.TextInput type="search" label="Поиск моделей" placeholder="Модель, провайдер или route-группа…" value={search()} onInput={setSearch} />
                <select class="mar-select" aria-label="Группировка каталога" value={grouping()} onChange={(event) => setGrouping(event.currentTarget.value as Grouping)}>
                  <option value="provider">Группировать: провайдер</option>
                  <option value="model">Группировать: model ID</option>
                  <option value="route">Группировать: route-группа</option>
                  <option value="price">Группировать: цена</option>
                  <option value="speed">Группировать: скорость</option>
                </select>
                <select class="mar-select" aria-label="Сортировка каталога" value={sorting()} onChange={(event) => setSorting(event.currentTarget.value as Sorting)}>
                  <option value="name">Сортировать: имя</option>
                  <option value="provider">Сортировать: провайдер</option>
                  <option value="price">Сортировать: цена ↑</option>
                  <option value="speed">Сортировать: скорость ↓</option>
                  <option value="ttfb">Сортировать: TTFB ↑</option>
                </select>
                <label class="mar-check-label"><input type="checkbox" checked={enabledOnly()} onChange={(event) => setEnabledOnly(event.currentTarget.checked)} /> Только разрешённые</label>
              </div>

              <section class="mar-panel">
                <div class="mar-table-head"><span>Модель / переключатель</span><span>Аккаунтная цена</span><span>Фактическая скорость</span><span>Отклик</span><span>Ручной выбор</span></div>
                <For each={sections()}>{(section) => (
                  <div class="mar-section">
                    <div class="mar-section-header">
                      <div class="mar-actions">
                        <ctx.ui.Switch
                          checked={section.models.some((model) => model.routingEnabled)}
                          disabled={saving() || section.models.every((model) => !model.enabled)}
                          hideLabel
                          label={`Разрешить все модели раздела ${section.title}`}
                          onChange={(enabled) => toggleModels(section.models, enabled)}
                        />
                        <span class="mar-section-name">{section.title}</span>
                      </div>
                      <span class="mar-section-meta">{section.models.filter((model) => model.routingEnabled).length} / {section.models.length} разрешено</span>
                    </div>
                    <For each={section.models}>{(model) => <ModelRow model={model} />}</For>
                  </div>
                )}</For>
                <Show when={sections().length === 0}><div class="mar-empty">Модели не найдены. Измените поиск или фильтр.</div></Show>
              </section>
              <p class="mar-footer-note">{accountsNote()} Цены — из аккаунтных API провайдеров в валюте аккаунта за миллион токенов, input / output первого тарифа; разные валюты не сравниваются между собой. Без подтверждения аккаунтным API цена не показывается. Порог остатка задаётся для каждого провайдера в валюте его аккаунта; границы цены — сразу для всех моделей в валюте цены. Ориентировка «≈» — приблизительная, по курсу ЦБ РФ, и в маршрутизации не используется. Скорость, TTFB и latency появляются после реальных шагов; это не заранее заданный бенчмарк. Переключатели каталога меняют только локальный роутинг и не изменяют credentials или глобальные настройки провайдера.</p>
            </Show>

            <Show when={tab() === "groups"}>
              <div class="mar-heading">
                <div><h3>Ручные route-группы</h3><p class="mar-subtitle">Соединяйте разные model ID, variant и провайдеров. Порядок в списке задаёт приоритет стратегии «Ручной приоритет».</p></div>
                <ctx.ui.Button variant="contrast" disabled={saving()} onClick={() => editGroup()}>Новая группа</ctx.ui.Button>
              </div>

              <Show when={editorOpen()}>
                <section class="mar-panel">
                  <div class="mar-panel-body">
                    <div class="mar-heading"><h3>{editorOriginal() ? `Изменить ${editorOriginal()}` : "Новая группа"}</h3><ctx.ui.Button size="small" variant="ghost" onClick={() => setEditorOpen(false)}>Закрыть</ctx.ui.Button></div>
                    <div class="mar-form-row"><label for="mar-group-name">Имя группы</label><ctx.ui.TextInput label="Имя группы" value={editorName()} onInput={setEditorName} /></div>
                    <div class="mar-form-row"><label for="mar-group-strategy">Стратегия</label><select id="mar-group-strategy" class="mar-select" value={editorStrategy()} onChange={(event) => setEditorStrategy(event.currentTarget.value as Strategy)}><For each={strategies}>{(item) => <option value={item.value}>{item.label}</option>}</For></select></div>
                    <div class="mar-editor">
                      <div class="mar-editor-column">
                        <h4>Добавить модели и variant</h4>
                        <ctx.ui.TextInput type="search" label="Поиск моделей для группы" placeholder="Найти среди всех моделей…" value={groupSearch()} onInput={setGroupSearch} />
                        <div class="mar-choice-list">
                          <For each={editorChoices().slice(0, 150)}>{(choice) => (
                            <label class="mar-choice">
                              <input type="checkbox" checked={editorModels().includes(choice.ref)} onChange={(event) => setEditorModels(event.currentTarget.checked ? [...editorModels(), choice.ref] : editorModels().filter((ref) => ref !== choice.ref))} />
                              <span><span class="mar-choice-name">{choice.name}</span><span class="mar-choice-detail">{choice.detail}{choice.enabled ? "" : " · сейчас не роутится"}</span></span>
                            </label>
                          )}</For>
                          <Show when={editorChoices().length === 0}><div class="mar-empty">Ничего не найдено</div></Show>
                        </div>
                        <Show when={editorChoices().length > 150}><p class="mar-help">Показаны первые 150 из {editorChoices().length}. Уточните поиск, чтобы увидеть остальные.</p></Show>
                      </div>
                      <div class="mar-editor-column">
                        <h4>Приоритет · {editorModels().length}</h4>
                        <ol class="mar-priority">
                          <For each={editorModels()}>{(ref, index) => (
                            <li class="mar-priority-row">
                              <span class="mar-priority-index">{index() + 1}</span>
                              <span class="mar-priority-model">{ref}</span>
                              <div class="mar-actions">
                                <ctx.ui.IconButton icon="arrow-up" size="small" label="Поднять приоритет" disabled={index() === 0} onClick={() => moveEditorModel(index(), -1)} />
                                <ctx.ui.IconButton icon="arrow-down-to-line" size="small" label="Снизить приоритет" disabled={index() === editorModels().length - 1} onClick={() => moveEditorModel(index(), 1)} />
                                <ctx.ui.IconButton icon="close-small" size="small" label="Убрать из группы" onClick={() => setEditorModels(editorModels().filter((item) => item !== ref))} />
                              </div>
                            </li>
                          )}</For>
                        </ol>
                        <Show when={editorModels().length === 0}><div class="mar-empty">Выберите модели слева</div></Show>
                      </div>
                    </div>
                    <div class="mar-actions"><ctx.ui.Button variant="contrast" busy={saving()} onClick={() => void saveGroup()}>Сохранить группу</ctx.ui.Button><ctx.ui.Button variant="ghost" disabled={saving()} onClick={() => setEditorOpen(false)}>Отмена</ctx.ui.Button></div>
                  </div>
                </section>
              </Show>

              <div class="mar-group-list">
                <For each={status()!.manualGroups}>{(group) => (
                  <article class="mar-group-card">
                    <div class="mar-group-card-title"><span class="mar-group-card-name">{group.name}</span><Show when={status()!.defaultGroup === group.name}><span class="mar-badge" data-tone="free">по умолчанию</span></Show></div>
                    <span class="mar-muted">{strategies.find((item) => item.value === group.strategy)?.label ?? group.strategy} · {group.models.length} моделей</span>
                    <ol class="mar-priority"><For each={group.models.slice(0, 5)}>{(ref, index) => <li class="mar-priority-model">{index() + 1}. {ref}</li>}</For></ol>
                    <Show when={group.models.length > 5}><span class="mar-help">и ещё {group.models.length - 5}</span></Show>
                    <div class="mar-actions"><ctx.ui.Button size="small" disabled={saving()} onClick={() => editGroup(group)}>Настроить</ctx.ui.Button><ctx.ui.Button size="small" variant="ghost" disabled={saving()} onClick={() => void configure({ defaultGroup: group.name })}>По умолчанию</ctx.ui.Button><ctx.ui.Button size="small" variant="danger" disabled={saving()} onClick={() => void removeGroup(group)}>Удалить</ctx.ui.Button></div>
                  </article>
                )}</For>
              </div>
              <Show when={status()!.manualGroups.length === 0 && !editorOpen()}><div class="mar-panel mar-empty">Ручных групп пока нет. Создайте группу, чтобы соединить любые модели и задать приоритет.</div></Show>

              <section class="mar-panel">
                <div class="mar-panel-body">
                  <h3>Автоматические группы · {status()!.groups.filter((group) => group.automatic).length}</h3>
                  <p class="mar-help">Создаются для chat-моделей с одинаковым ID минимум у двух провайдеров. Локально отключённые участники не выбираются, но сохраняются для распознавания текущей модели; общую стратегию можно задать выше.</p>
                  <div class="mar-group-list"><For each={status()!.groups.filter((group) => group.automatic)}>{(group) => <div class="mar-group-card"><span class="mar-group-card-name">{group.name}</span><span class="mar-muted">{group.candidates.length} провайдеров · {group.strategy}</span></div>}</For></div>
                </div>
              </section>
            </Show>

            <div class="mar-actions">
              <ctx.ui.Button variant="ghost-muted" size="small" disabled={saving()} onClick={() => { void (async () => { if (await ctx.dialogs.confirm({ title: "Сбросить настройки autorouter?", description: "Будут восстановлены значения из opencode.json. Метрики и credentials не изменятся.", confirm: "Сбросить", danger: true })) await configure({ reset: true }, "Настройки сброшены") })() }}>Сбросить настройки</ctx.ui.Button>
              <span class="mar-help">Включение/выключение самих серверных плагинов выполняется штатными средствами OpenCode; этот переключатель управляет поведением autorouter.</span>
            </div>
          </Show>
        </div>
      )
    }

    ctx.add(SettingsPage, {
      id: ctx.id,
      title: "Model Autorouter",
      icon: "models",
      entries: [
        { id: ctx.id, title: "Model Autorouter", description: "Модели, провайдеры, цена, скорость и route-группы", keywords: "models providers routing failover price speed groups модели провайдеры цена скорость" },
      ],
      render: () => <RouterPage />,
    })
    ctx.add(Command, {
      id: "open",
      title: "Открыть Model Autorouter",
      description: "Модели, цена, скорость и группы провайдеров",
      run: () => ctx.layout.settings(ctx.id),
    })
  },
})
