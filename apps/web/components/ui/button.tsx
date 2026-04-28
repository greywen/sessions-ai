import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-normal whitespace-nowrap transition-[opacity,box-shadow,background-color,color,border-color,transform] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:shadow-[0_4px_12px_rgba(0,0,0,0.1)] disabled:pointer-events-none disabled:opacity-50 active:opacity-80 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_0.5px_0_rgba(255,255,255,0.2),inset_0_0_0_0.5px_rgba(0,0,0,0.2),0_1px_2px_rgba(0,0,0,0.05)] hover:opacity-90",
        outline:
          "border-[rgba(28,28,28,0.4)] bg-transparent text-foreground hover:bg-[rgba(28,28,28,0.04)] aria-expanded:bg-[rgba(28,28,28,0.04)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[rgba(28,28,28,0.08)] aria-expanded:bg-[rgba(28,28,28,0.08)]",
        ghost:
          "text-foreground hover:bg-[rgba(28,28,28,0.04)] aria-expanded:bg-[rgba(28,28,28,0.04)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[inset_0_0.5px_0_rgba(255,255,255,0.16),inset_0_0_0_0.5px_rgba(0,0,0,0.2),0_1px_2px_rgba(0,0,0,0.06)] hover:opacity-90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-8 gap-1.5 px-3 text-sm has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-10 gap-1.5 px-5 text-sm has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-9 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-10 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
