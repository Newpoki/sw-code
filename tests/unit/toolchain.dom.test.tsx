import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>
}

describe("test toolchain (jsdom environment)", () => {
  it("renders a React component with @testing-library/react", () => {
    render(<Greeting name="roster" />)
    expect(screen.getByText("Hello roster")).toBeTruthy()
  })

  it("runs in the jsdom environment", () => {
    expect(typeof document).toBe("object")
  })
})
