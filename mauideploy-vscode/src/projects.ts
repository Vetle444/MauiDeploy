import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isMauiProject } from './devices';

export async function findWorkspaceMauiProjects(): Promise<string[]> {
    const results: string[] = [];
    const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', '**/node_modules/**', 20);
    for (const uri of csprojFiles) {
        if (isMauiProject(uri.fsPath)) {
            results.push(uri.fsPath);
        }
    }
    return results;
}

export function findCsprojsInDir(dir: string, depth = 0): string[] {
    const results: string[] = [];
    if (depth > 5) { return results; }
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith('.csproj')) {
                results.push(full);
            } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                results.push(...findCsprojsInDir(full, depth + 1));
            }
        }
    } catch { /* permission denied */ }
    return results;
}
