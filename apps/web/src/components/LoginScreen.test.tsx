import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen.js";

afterEach(cleanup);

describe("LoginScreen", () => {
  it("accepts either a tenant password or administrator PIN", () => {
    const onLogin = vi.fn();
    render(<LoginScreen busy={false} error="" pairedViewer={false} onLogin={onLogin} />);

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("admin", { selector: "code" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "Taylor.User" } });
    fireEvent.change(screen.getByLabelText("Password or PIN"), { target: { value: "Secure!2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onLogin).toHaveBeenCalledWith("taylor.user", "Secure!2026");
  });
});
