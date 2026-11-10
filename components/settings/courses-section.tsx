"use client";
/**
 * THE COURSES SETTINGS SECTION (2026-11-09) — where the problem folders
 * live, which host VS Code opens over SSH, and how a problem is done by
 * default.
 *
 * The workspace root is the folder the problem sets are created in (and
 * the one VS Code opens) — `~/cs50` by default. The host is the machine
 * the server runs on, used by the `vscode://vscode-remote/ssh-remote+…`
 * link. The default mode is the way a problem is done when the learner
 * does not choose: in the app's workspace, or in VS Code.
 */

import type { CoursesSettings } from "@/src/core";
import { CommitInput, SettingsRow, ThinSelect } from "./controls.tsx";

export function CoursesSection({
	courses,
	onSectionChange,
}: {
	courses: CoursesSettings | undefined;
	onSectionChange: (next: CoursesSettings) => void;
}) {
	const workspaceRoot = courses?.workspaceRoot ?? "~/cs50";
	const vscodeHost = courses?.vscodeHost ?? "5090v1";
	const defaultMode = courses?.defaultMode ?? "app";

	return (
		<div data-testid="courses-settings">
			<SettingsRow
				label="Workspace folder"
				hint="Where the problem sets are created — the same folder VS Code opens."
				testid="courses-workspace-root"
			>
				<CommitInput
					value={workspaceRoot}
					placeholder="~/cs50"
					ariaLabel="Workspace folder"
					testid="courses-workspace-root-input"
					onCommit={(next) => onSectionChange({ ...courses, workspaceRoot: next || "~/cs50" })}
				/>
			</SettingsRow>
			<SettingsRow
				label="VS Code host"
				hint="The machine the server runs on — used by the remote VS Code link."
				testid="courses-vscode-host"
			>
				<CommitInput
					value={vscodeHost}
					placeholder="5090v1"
					ariaLabel="VS Code host"
					testid="courses-vscode-host-input"
					onCommit={(next) => onSectionChange({ ...courses, vscodeHost: next || "5090v1" })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Default problem mode"
				hint="How a problem is done unless you pick the other way for that one."
				testid="courses-default-mode"
			>
				<ThinSelect
					value={defaultMode}
					ariaLabel="Default problem mode"
					testid="courses-default-mode-select"
					onChange={(next) => onSectionChange({ ...courses, defaultMode: next === "vscode" ? "vscode" : "app" })}
				>
					<option value="app">In the app</option>
					<option value="vscode">In VS Code</option>
				</ThinSelect>
			</SettingsRow>
		</div>
	);
}
