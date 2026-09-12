"use client"

import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          /*
           * Keep every child inside the max width above.
           *
           * Three separate things are needed, because a grid container leaks its
           * content in two ways and long text leaks in a third:
           *
           * 1. `grid-cols-[minmax(0,1fr)]` — an implicit grid track is sized
           *    `auto`, whose minimum is the *max-content* width of the widest
           *    item. One unbreakable string (a 64-character Hive_ID, a coupon
           *    code, an upstream `retMsg`) therefore widens the track past
           *    `max-w-sm` and the whole dialog overflows. Naming the track
           *    `minmax(0, 1fr)` sets that minimum to 0, so the track is capped by
           *    the container instead of by its content.
           * 2. `[&>*]:min-w-0` — grid *items* carry `min-width: auto` for the
           *    same reason, so an item can still overflow its own (now correctly
           *    sized) track. This lets each direct child shrink. It is what makes
           *    a nested flex row, table, or `<pre>` behave.
           * 3. `break-words` — shrinking only helps if the content can reflow. A
           *    single token longer than the line still sticks out, so long words
           *    are allowed to break mid-word. `overflow-wrap` is inherited, so
           *    this one declaration covers the title, the description, lists, and
           *    any nested text without repeating itself. Normal prose is
           *    unaffected: the break only applies to a word that cannot fit.
           */
          "break-words grid-cols-[minmax(0,1fr)] [&>*]:min-w-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        /*
         * Some action labels in this app are sentences rather than verbs — the
         * roster removal control renders "Remove" followed by a Member_Label of
         * up to 40 characters. `Button` is deliberately `shrink-0` and
         * `whitespace-nowrap`, which is right in a toolbar or a table row but
         * makes a footer overflow here, and no amount of shrinking on the
         * container can fix a child that refuses to shrink.
         *
         * So the override is scoped to dialog footers rather than applied to
         * `Button` itself: `sm:flex-wrap` lets two buttons that do not fit on one
         * row drop onto two, and the per-button rules let a single over-long label
         * wrap inside its own button. `h-auto` with `min-h-8` keeps the normal
         * height for the short labels that are the common case and grows only when
         * the text actually wraps, so nothing is clipped.
         */
        "sm:flex-wrap [&_button]:h-auto [&_button]:min-h-8 [&_button]:min-w-0 [&_button]:shrink [&_button]:py-1.5 [&_button]:whitespace-normal",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
