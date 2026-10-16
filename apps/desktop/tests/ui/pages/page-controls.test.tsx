import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import projects from "../../../../../fixtures/domain/projections/projects.json";
import sessions from "../../../../../fixtures/domain/projections/sessions.json";
import type { ProjectSummary, SessionSummary } from "../../../src/generated/domain/models";
import { DiscoveryController } from '../../../src/data/discovery';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport } from '../app/transport';
import { ProjectsPage } from "../../../src/ui/pages/ProjectsPage";

const discoveryControllers: DiscoveryController[] = [];
afterEach(() => { cleanup(); discoveryControllers.splice(0).forEach(controller => controller.dispose()); });
function setup(disabled = false, discovery?: DiscoveryController) {
  const open = vi.fn(), register = vi.fn(), remove = vi.fn(async () => true), openSession = vi.fn();
  render(<ProjectsPage projects={projects.items.slice(0, 1) as ProjectSummary[]} sessions={sessions.items as SessionSummary[]} snapshots={new Map()} now={Date.now()}
    disabled={disabled} discovery={discovery} onOpen={open} onOpenSession={openSession} onRegister={register} onRemove={remove} />);
  return { open, register, remove, openSession };
}
const menuItem = (name: string) => screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });
describe("Projects page controls", () => {
  it("opens a project and keeps registration explicit", () => {
    const { open, register } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Ariadne canonical demo$/ }));
    expect(open).toHaveBeenCalledWith(projects.items[0].project_id);
    fireEvent.click(screen.getByRole("button", { name: "Register a project, discover sessions" }));
    fireEvent.click(menuItem("Register a project…"));
    expect(register).toHaveBeenCalledWith("");
  });
  it.each(["Cancel", "Escape"])("cancels project removal with %s without removing or opening it", key => {
    const { open, remove } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^More for .*: remove project$/ }));
    fireEvent.click(menuItem("Remove project…"));
    const dialog = screen.getByRole("dialog", { name: /^Remove “.*” from Ariadne\?$/ });
    if (key === "Cancel") fireEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
    else fireEvent.keyDown(dialog, { key });
    expect(screen.queryByRole("dialog", { name: /^Remove/ })).toBeNull();
    expect(remove).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it("removes a project from its card's menu through the Remove project dialog", () => {
    const { remove } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^More for .*: remove project$/ }));
    fireEvent.click(menuItem("Remove project…"));
    fireEvent.click(screen.getByRole("button", { name: /^Remove project/ }));
    expect(remove).toHaveBeenCalledWith({ kind: "project", project_id: projects.items[0].project_id }, expect.objectContaining({ kind: "project" }));
    expect(screen.queryByRole("dialog", { name: /^Remove/ })).toBeNull();
  });
  it("disables registration and project opening while navigation is saving", () => {
    const { open, register } = setup(true);
    fireEvent.click(screen.getByRole("button", { name: /^Ariadne canonical demo$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register a project, discover sessions" }));
    fireEvent.click(menuItem("Register a project…"));
    expect(open).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
  it('opens discovery explicitly, refreshes without persistence, and closes on Escape', async () => {
    class Transport extends AppTransport {
      discovery = vi.fn(async () => ({ candidates: [], error: null }));
      setConnectionUiOpen = vi.fn(async () => {});
    }
    const transport = new Transport(), discovery = new DiscoveryController(createDesktopService(transport)); discoveryControllers.push(discovery);
    setup(false, discovery);
    expect(transport.discovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Register a project, discover sessions' }));
    fireEvent.click(menuItem('Discover sessions'));
    const dialog = screen.getByRole('dialog', { name: 'Discover sessions' });
    await screen.findByText('No discovered host sessions. Manual entry remains available.');
    const reads = transport.discovery.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh host sessions' }));
    await waitFor(() => expect(transport.discovery.mock.calls.length).toBeGreaterThan(reads));
    expect(transport.mutations).toEqual([]);
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(transport.setConnectionUiOpen.mock.calls.at(-1)).toEqual([false]));
  });

});
