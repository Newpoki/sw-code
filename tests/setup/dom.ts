import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

// Globals are off, so @testing-library/react cannot auto-register its cleanup.
afterEach(() => {
  cleanup()
})
