import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Device } from './devices';
import { parseRepositoryUrl } from './branchSources';
import { GitRepository } from './worktrees';

export interface BranchDeployProfile {
    version: 1;
    repositoryRoot: string;
    commonDirectory: string;
    remote: string;
    repositoryUrl: string;
    projectPath: string;
    configuration: 'Debug';
    device?: Pick<Device, 'id' | 'name' | 'platform' | 'type'>;
}

const profilesDirectory = path.join(os.homedir(), '.mauideploy', 'branch-deploy');

function profilePath(commonDirectory: string): string {
    const key = createHash('sha256').update(commonDirectory).digest('hex');
    return path.join(profilesDirectory, `${key}.json`);
}

export function validateProfile(value: unknown): BranchDeployProfile {
    const profile = value as BranchDeployProfile | undefined;
    if (profile?.version !== 1 || !path.isAbsolute(profile.repositoryRoot ?? '') ||
        !path.isAbsolute(profile.commonDirectory ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(profile.remote ?? '') ||
        !['Debug', 'Release'].includes(profile.configuration)) {
        throw new Error('Invalid branch deployment setup. Run mauideploy setup again.');
    }
    if (profile.device !== undefined) {
        const device = profile.device;
        if (!device?.id || !device.name || !['iOS', 'Android'].includes(device.platform) ||
            !['physical', 'simulator'].includes(device.type)) {
            throw new Error('Invalid saved deployment device. Run mauideploy setup again.');
        }
    }
    validateProjectPath(profile.projectPath);
    parseRepositoryUrl(profile.repositoryUrl);
    return {
        version: 1,
        repositoryRoot: profile.repositoryRoot,
        commonDirectory: profile.commonDirectory,
        remote: profile.remote,
        repositoryUrl: profile.repositoryUrl,
        projectPath: profile.projectPath,
        configuration: 'Debug',
        device: profile.device
    };
}

function validateProjectPath(projectPath: string): void {
    if (!projectPath || path.isAbsolute(projectPath) || projectPath.split(/[\\/]/).includes('..') ||
        !projectPath.toLowerCase().endsWith('.csproj')) {
        throw new Error('The deployment project must be a relative .csproj path inside the repository.');
    }
}

export async function resolveDeploymentProject(directory: string, relativePath: string): Promise<string> {
    validateProjectPath(relativePath);
    const root = await fs.promises.realpath(directory);
    let project: string;
    try {
        project = await fs.promises.realpath(path.resolve(root, relativePath));
    } catch {
        throw new Error(`The selected branch does not contain ${relativePath}. Run mauideploy setup to change the project.`);
    }
    const relative = path.relative(root, project);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('The deployment project resolves outside the worktree.');
    }
    return project;
}

export async function readBranchProfile(repository: GitRepository): Promise<BranchDeployProfile | undefined> {
    try {
        const profile = validateProfile(JSON.parse(await fs.promises.readFile(profilePath(repository.commonDirectory), 'utf8')));
        if (profile.commonDirectory !== repository.commonDirectory) { throw new Error('The configured repository has changed.'); }
        return profile;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
        throw error;
    }
}

export async function readBranchProfiles(): Promise<BranchDeployProfile[]> {
    let files: string[];
    try {
        files = await fs.promises.readdir(profilesDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
        throw error;
    }
    return Promise.all(files.filter(file => file.endsWith('.json')).map(async file =>
        validateProfile(JSON.parse(await fs.promises.readFile(path.join(profilesDirectory, file), 'utf8')))
    ));
}

export async function saveBranchProfile(profile: BranchDeployProfile): Promise<void> {
    const normalized = validateProfile(profile);
    await fs.promises.mkdir(profilesDirectory, { recursive: true, mode: 0o700 });
    const destination = profilePath(normalized.commonDirectory);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
        await fs.promises.writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await fs.promises.rename(temporary, destination);
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
}