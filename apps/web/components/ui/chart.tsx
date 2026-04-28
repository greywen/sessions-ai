"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils"

const THEMES = { light: "", dark: ".dark" } as const

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode
    icon?: React.ComponentType<{ className?: string }>
    color?: string
    theme?: Partial<Record<keyof typeof THEMES, string>>
  }
>

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }
  return context
}

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    config: ChartConfig
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"]
  }
>(({ id, className, children, config, ...props }, ref) => {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        ref={ref}
        className={cn(
          "flex justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border [&_.recharts-legend-item-text]:fill-foreground [&_.recharts-pie-label-text]:fill-foreground [&_.recharts-layer:focus]:outline-none [&_.recharts-sector:focus]:outline-none [&_.recharts-bar-rectangle:focus]:outline-none [&_.recharts-dot:focus]:outline-none",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
})
ChartContainer.displayName = "ChartContainer"

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(([, item]) => item.color || item.theme)

  if (!colorConfig.length) {
    return null
  }

  const css = Object.entries(THEMES)
    .map(([theme, prefix]) => {
      const declarations = colorConfig
        .map(([key, item]) => {
          const color = item.theme?.[theme as keyof typeof THEMES] || item.color
          if (!color) return null
          return `--color-${key}: ${color};`
        })
        .filter(Boolean)
        .join("")

      if (!declarations) return ""
      return `${prefix} [data-chart=\"${id}\"] {${declarations}}`
    })
    .join("\n")

  return <style dangerouslySetInnerHTML={{ __html: css }} />
}

const ChartTooltip = RechartsPrimitive.Tooltip

type TooltipContentProps = React.ComponentProps<"div"> & {
  active?: boolean
  payload?: Array<Record<string, any>>
  formatter?: (
    value: unknown,
    name: unknown,
    item: Record<string, any>,
    index: number,
    payload: Array<Record<string, any>>,
  ) => React.ReactNode
  hideIndicator?: boolean
  hideLabel?: boolean
  indicator?: "dot" | "line" | "dashed"
  label?: React.ReactNode
  labelFormatter?: (value: React.ReactNode) => React.ReactNode
  labelKey?: string
  nameKey?: string
}

function ChartTooltipContent({
  active,
  payload,
  className,
  formatter,
  hideIndicator = false,
  hideLabel = false,
  indicator = "dot",
  label,
  labelFormatter,
  labelKey,
  nameKey,
}: TooltipContentProps) {
  const { config } = useChart()

  if (!active || !payload?.length) {
    return null
  }

  const tooltipLabel = hideLabel
    ? null
    : (() => {
        const firstItem = payload[0]
        const key = String((labelKey && firstItem?.payload?.[labelKey]) || firstItem?.dataKey || firstItem?.name || "")
        const cfg = config[key]
        const content = cfg?.label || label
        if (labelFormatter) return labelFormatter(content)
        return content
      })()

  return (
    <div
      className={cn(
        "min-w-[11rem] rounded-md border border-border bg-card px-3 py-2 text-sm shadow-[0_4px_12px_rgba(0,0,0,0.1)]",
        className,
      )}
    >
      {tooltipLabel ? <div className="mb-1 text-xs text-muted-foreground">{tooltipLabel}</div> : null}
      <div className="space-y-1.5">
        {payload.map((item, index) => {
          const rawKey = String(
            (nameKey && item?.payload?.[nameKey]) ||
              item?.dataKey ||
              item?.name ||
              item?.payload?.name ||
              `item-${index}`,
          )
          const itemConfig = config[rawKey]
          const itemLabel = itemConfig?.label || item?.name || rawKey
          const color =
            (item?.color as string | undefined) ||
            (item?.payload?.fill as string | undefined) ||
            `var(--color-${rawKey})`

          const formatted = formatter
            ? formatter(item?.value, itemLabel, item, index, payload)
            : null

          if (formatted) {
            return <div key={`${rawKey}-${index}`}>{formatted}</div>
          }

          return (
            <div key={`${rawKey}-${index}`} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {!hideIndicator && (
                  <span
                    className={cn(
                      "inline-block shrink-0 rounded-sm",
                      indicator === "dot" && "h-2 w-2 rounded-full",
                      indicator === "line" && "h-0.5 w-3",
                      indicator === "dashed" && "h-0.5 w-3 border-t border-dashed border-current bg-transparent",
                    )}
                    style={
                      indicator === "dashed"
                        ? { color }
                        : { backgroundColor: color }
                    }
                  />
                )}
                <span className="text-muted-foreground">{itemLabel}</span>
              </div>
              <span className="font-mono tabular-nums text-foreground">{String(item?.value ?? "-")}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ChartLegend = RechartsPrimitive.Legend

type LegendContentProps = React.ComponentProps<"div"> & {
  payload?: Array<Record<string, any>>
  nameKey?: string
}

function ChartLegendContent({ className, payload, nameKey }: LegendContentProps) {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-4 text-xs", className)}>
      {payload.map((item, index) => {
        const rawKey = String(
          (nameKey && item?.payload?.[nameKey]) ||
            item?.dataKey ||
            item?.value ||
            item?.payload?.name ||
            `item-${index}`,
        )
        const itemConfig = config[rawKey]
        const color =
          (item?.color as string | undefined) ||
          (item?.payload?.fill as string | undefined) ||
          `var(--color-${rawKey})`
        const Icon = itemConfig?.icon

        return (
          <div key={`${rawKey}-${index}`} className="flex items-center gap-1.5 text-muted-foreground">
            {Icon ? (
              <Icon className="h-3.5 w-3.5" />
            ) : (
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            )}
            <span>{itemConfig?.label || item?.value || rawKey}</span>
          </div>
        )
      })}
    </div>
  )
}

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
}