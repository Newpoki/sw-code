"use client"

import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

/**
 * A side drawer: a panel anchored to the right edge that slides in over the page.
 *
 * ## Built on Radix Dialog rather than on `vaul`
 *
 * The shadcn drawer is normally `vaul`, which adds drag-to-dismiss and a grabber
 * handle. `vaul` is not a dependency of this repository, and a side panel is a
 * modal dialog with different positioning and a different transition — nothing
 * about it needs a second primitive. So this is built on the Radix Dialog the app
 * already ships, which keeps the dependency list unchanged and gives the drawer
 * the focus trap, focus restore, `Escape` handling, scroll lock, and
 * `aria-modal` wiring for free. The visible difference from `vaul` is that this
 * drawer cannot be swiped away, only closed.
 *
 * ## Overflow is handled here, not by each caller
 *
 * A drawer exists to show detail, and in this app that detail includes upstream
 * messages of up to 500 characters and Hive_IDs of up to 64 unbroken characters.
 * {@link DrawerContent} therefore fixes the three things that otherwise let such
 * content escape a fixed-width panel — the same three that had to be fixed on
 * `DialogContent`: the body scrolls on its own axis, direct children may shrink
 * below their max-content width, and over-long words may break. A caller passing
 * a long string does not have to think about it.
 */

function Drawer({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPrimitive.Portal data-slot="drawer-portal">
      <DrawerOverlay />
      <DialogPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          /* Full-height panel pinned to the right edge, full width on a narrow
           * viewport so the content is not squeezed into a sliver. */
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 duration-150 outline-none",
          "data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          /* See the module note: let children shrink, let long words break. The
           * panel is a fixed width, so anything unbreakable inside it would
           * otherwise push straight through the edge. */
          "break-words [&>*]:min-w-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="drawer-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b p-4 pr-12",
        className
      )}
      {...props}
    />
  )
}

/**
 * The scrolling region of the drawer.
 *
 * `min-h-0` is what actually makes `overflow-y-auto` work here: this is a flex
 * item in a column flex container, and a flex item's automatic minimum size is
 * its content, so without it the region grows to fit its content and the panel
 * scrolls the page instead of scrolling itself.
 */
function DrawerBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-body"
      className={cn("min-h-0 flex-1 overflow-y-auto p-4", className)}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn("font-heading text-base font-medium", className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerTitle,
  DrawerTrigger,
}
