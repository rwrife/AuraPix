import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  it("renders the app shell with navigation links", async () => {
    render(<App />);

    expect(screen.getByText("AuraPix")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Albums" })).toBeInTheDocument();
  });

  it("shows the library page by default", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Library" })).toBeInTheDocument();
  });

  it("displays the current user in the header", async () => {
    render(<App />);

    // In local mode the auto-signed-in user's display name appears
    expect(await screen.findByText("Local User")).toBeInTheDocument();
  });
});