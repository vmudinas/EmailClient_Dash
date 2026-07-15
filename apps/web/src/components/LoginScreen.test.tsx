import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen.js";

afterEach(cleanup);

describe("LoginScreen", () => {
  it("requires a named user and numeric PIN before entering the client", () => {
    const onLogin = vi.fn();
    render(<LoginScreen busy={false} error="" pairedViewer={false} onLogin={onLogin} />);

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText(/admin/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "23a32" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onLogin).toHaveBeenCalledWith("admin", "2332");
  });
});
