const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { getGitRepository, resolveCommit, withDeploymentWorktree } = require('../out/worktrees');
const {
    parseRepositoryUrl, parsePullRequestUrl, parseDeployLink, createPullRequestLink, sameRepository,
    listBranches, listMatchingRemotes, resolveBranchCommit, fetchPullRequestCommit
} = require('../out/branchSources');
const { validateProfile, resolveDeploymentProject } = require('../out/branchProfiles');

function git(directory, ...args) {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repositoryFixture(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-branches-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'App Repository');
    fs.mkdirSync(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'MauiDeploy Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, '.gitignore'), 'bin/\nobj/\n');
    fs.writeFileSync(path.join(root, 'App.csproj'), '<Project />');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Initial');
    const firstCommit = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-b', 'feature/agent');
    fs.writeFileSync(path.join(root, 'App.csproj'), '<Project Sdk="Changed" />');
    git(root, 'commit', '-am', 'Agent commit');
    return { root, firstCommit, secondCommit: git(root, 'rev-parse', 'HEAD') };
}

test('detached deployments reuse one worktree and preserve the active branch, index and working files', async context => {
    const fixture = repositoryFixture(context);
    fs.writeFileSync(path.join(fixture.root, 'App.csproj'), 'uncommitted agent changes');
    fs.writeFileSync(path.join(fixture.root, 'untracked.txt'), 'keep me');
    const sourceStatus = git(fixture.root, 'status', '--porcelain=v1');
    const sourceIndex = fs.readFileSync(path.join(fixture.root, '.git', 'index'));
    const repository = await getGitRepository(fixture.root);
    const commit = await resolveCommit(repository, 'refs/heads/feature/agent');
    assert.equal(commit, fixture.secondCommit);
    await withDeploymentWorktree(repository, commit, async directory => {
        assert.equal(git(directory, 'branch', '--show-current'), '');
        assert.equal(git(directory, 'rev-parse', 'HEAD'), fixture.secondCommit);
        fs.mkdirSync(path.join(directory, 'bin'));
        fs.writeFileSync(path.join(directory, 'bin', 'cached-build'), 'reuse');
        const sameRepository = await getGitRepository(directory);
        assert.equal(sameRepository.worktreePath, repository.worktreePath);
        await assert.rejects(withDeploymentWorktree(repository, commit, async () => {}), /already using/);
    });
    await withDeploymentWorktree(repository, fixture.firstCommit, async directory => {
        assert.equal(directory, repository.worktreePath);
        assert.equal(git(directory, 'rev-parse', 'HEAD'), fixture.firstCommit);
        assert.equal(fs.readFileSync(path.join(directory, 'bin', 'cached-build'), 'utf8'), 'reuse');
    });
    assert.equal(git(fixture.root, 'branch', '--show-current'), 'feature/agent');
    assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), fixture.secondCommit);
    assert.deepEqual(fs.readFileSync(path.join(fixture.root, '.git', 'index')), sourceIndex);
    assert.equal(git(fixture.root, 'status', '--porcelain=v1'), sourceStatus);
    assert.equal(fs.readFileSync(path.join(fixture.root, 'App.csproj'), 'utf8'), 'uncommitted agent changes');
});

test('local deployment edits are never discarded and failures release the repository lock', async context => {
    const fixture = repositoryFixture(context);
    const repository = await getGitRepository(fixture.root);
    await assert.rejects(withDeploymentWorktree(repository, fixture.firstCommit, async () => {
        throw new Error('Build failed');
    }), /Build failed/);
    fs.writeFileSync(path.join(repository.worktreePath, 'notes.txt'), 'keep deployment notes');
    await assert.rejects(withDeploymentWorktree(repository, fixture.secondCommit, async () => {
        assert.fail('Must not deploy a dirty worktree');
    }), /local changes/);
    assert.equal(git(repository.worktreePath, 'rev-parse', 'HEAD'), fixture.firstCommit);
    assert.equal(fs.readFileSync(path.join(repository.worktreePath, 'notes.txt'), 'utf8'), 'keep deployment notes');
    assert.equal(fs.existsSync(path.join(repository.commonDirectory, 'mauideploy.lock')), false);
});

test('an existing directory at the deployment location is never adopted or overwritten', async context => {
    const fixture = repositoryFixture(context);
    const repository = await getGitRepository(fixture.root);
    fs.mkdirSync(repository.worktreePath);
    fs.writeFileSync(path.join(repository.worktreePath, 'notes.txt'), 'user data');
    await assert.rejects(withDeploymentWorktree(repository, fixture.firstCommit, async () => {}), /unmanaged/);
    assert.equal(fs.readFileSync(path.join(repository.worktreePath, 'notes.txt'), 'utf8'), 'user data');
});

test('branch discovery and fetching preserve FETCH_HEAD and remote-tracking branches', async context => {
    const fixture = repositoryFixture(context);
    git(fixture.root, 'remote', 'add', 'origin', fixture.root);
    git(fixture.root, 'update-ref', 'refs/remotes/origin/feature/agent', fixture.firstCommit);
    fs.writeFileSync(path.join(fixture.root, '.git', 'FETCH_HEAD'), 'agent fetch state\n');
    const repository = await getGitRepository(fixture.root);
    const branches = await listBranches(repository, 'origin');
    assert.ok(branches.some(branch => branch.name === 'feature/agent' && branch.remote === 'origin'));
    assert.ok(branches.some(branch => branch.name === 'feature/agent' && !branch.remote));
    assert.equal(await resolveBranchCommit(repository, { name: 'feature/agent', remote: 'origin' }), fixture.secondCommit);
    assert.equal(fs.readFileSync(path.join(fixture.root, '.git', 'FETCH_HEAD'), 'utf8'), 'agent fetch state\n');
    assert.equal(git(fixture.root, 'rev-parse', 'refs/remotes/origin/feature/agent'), fixture.firstCommit);
    assert.equal(git(fixture.root, 'for-each-ref', '--format=%(refname)', 'refs/mauideploy/'), '');
    await assert.rejects(resolveBranchCommit(repository, { name: '--upload-pack=unexpected', remote: 'origin' }), /Invalid branch/);
});

test('PR fetching freezes the inspected head and rejects a push racing the fetch', async context => {
    const fixture = repositoryFixture(context);
    git(fixture.root, 'remote', 'add', 'origin', fixture.root);
    git(fixture.root, 'update-ref', 'refs/pull/42/head', fixture.secondCommit);
    const repository = await getGitRepository(fixture.root);
    const reference = parsePullRequestUrl('https://github.com/example/app/pull/42');
    assert.equal(await fetchPullRequestCommit(repository, 'origin', reference, {
        repository: reference.repository, commit: fixture.secondCommit
    }), fixture.secondCommit);
    await assert.rejects(fetchPullRequestCommit(repository, 'origin', reference, {
        repository: reference.repository, commit: fixture.firstCommit
    }), /changed while/);
});

test('PR links identify GitHub and Enterprise repositories without accepting commands or local paths', () => {
    const repository = parseRepositoryUrl('git@dips.ghe.com:Team/Mobile.git');
    assert.equal(repository.url, 'https://dips.ghe.com/Team/Mobile');
    assert.ok(sameRepository(repository, parseRepositoryUrl('https://dips.ghe.com/team/mobile')));
    const reference = parsePullRequestUrl('https://dips.ghe.com/Team/Mobile/pull/12/files#diff-123');
    assert.equal(reference.number, 12);
    const params = new URLSearchParams({ repo: repository.url, pr: '12' });
    const link = `vscode://FinstadProductions.maui-deploy/deploy-pr?${params}`;
    assert.deepEqual(parseDeployLink(link, 'vscode'), { repository, number: 12 });
    for (const unsafe of [
        `${link}&command=build`, `${link}&repo=https://github.com/other/repo`,
        link.replace('pr=12', 'pr=-1'), link.replace('deploy-pr', 'setup'),
        link.replace('FinstadProductions', 'OtherPublisher'),
        'vscode://FinstadProductions.maui-deploy/deploy-pr?repo=file:///tmp/repo&pr=12'
    ]) {
        assert.throws(() => parseDeployLink(unsafe, 'vscode'));
    }
    assert.throws(() => parsePullRequestUrl('https://token@github.com/team/repo/pull/12'));
    assert.throws(() => parsePullRequestUrl('https://github.com/team/repo/pull/12/../../issues'));
});

test('GHE remotes with a custom SSH username match HTTPS PR links without changing Git configuration', async context => {
    const fixture = repositoryFixture(context);
    const remoteUrl = 'employee@dips.ghe.com:Team/Mobile.git';
    git(fixture.root, 'remote', 'add', 'origin', remoteUrl);
    git(fixture.root, 'remote', 'add', 'public', 'git@github.com:Team/Mobile.git');
    const reference = parsePullRequestUrl('https://dips.ghe.com/Team/Mobile/pull/12');
    for (const value of [remoteUrl, 'git@dips.ghe.com:Team/Mobile.git', 'ssh://employee@dips.ghe.com/Team/Mobile.git']) {
        assert.deepEqual(parseRepositoryUrl(value), reference.repository);
    }
    const repository = await getGitRepository(fixture.root);
    assert.deepEqual(await listMatchingRemotes(repository, reference.repository), ['origin']);
    assert.equal(git(fixture.root, 'remote', 'get-url', 'origin'), remoteUrl);
    const bridge = new URL(createPullRequestLink(`${reference.repository.url}/pull/12`));
    const deepLink = `vscode://FinstadProductions.maui-deploy/deploy-pr?${bridge.hash.slice(1)}`;
    assert.deepEqual(parseDeployLink(deepLink, 'vscode'), reference);
});

test('shareable PR links keep repository details in the browser fragment and allow self-hosted bridges', () => {
    const link = new URL(createPullRequestLink('https://dips.ghe.com/team/app/pull/12', 'https://deploy.example.com/open/', true));
    assert.equal(link.origin, 'https://deploy.example.com');
    assert.equal(link.search, '');
    const parameters = new URLSearchParams(link.hash.slice(1));
    assert.equal(parameters.get('repo'), 'https://dips.ghe.com/team/app');
    assert.equal(parameters.get('pr'), '12');
    assert.equal(parameters.get('editor'), 'vscode-insiders');
    assert.throws(() => createPullRequestLink('https://github.com/team/app/pull/12', 'javascript:alert(1)'));
});

test('saved setup cannot redirect a deployment project outside its worktree', async context => {
    const fixture = repositoryFixture(context);
    assert.equal(await resolveDeploymentProject(fixture.root, 'App.csproj'), fs.realpathSync(path.join(fixture.root, 'App.csproj')));
    await assert.rejects(resolveDeploymentProject(fixture.root, '../App.csproj'), /relative/);
    await assert.rejects(resolveDeploymentProject(fixture.root, 'Missing.csproj'), /does not contain/);
    const outside = path.join(path.dirname(fixture.root), 'Outside.csproj');
    fs.writeFileSync(outside, '<Project />');
    fs.symlinkSync(outside, path.join(fixture.root, 'Linked.csproj'));
    await assert.rejects(resolveDeploymentProject(fixture.root, 'Linked.csproj'), /outside/);
    const profile = {
        version: 1, repositoryRoot: fixture.root, commonDirectory: path.join(fixture.root, '.git'),
        remote: 'origin', repositoryUrl: 'https://github.com/example/app', projectPath: 'App.csproj',
        configuration: 'Debug', device: { id: 'device', name: 'Phone', platform: 'iOS', type: 'physical' }
    };
    assert.deepEqual(validateProfile(profile), profile);
    assert.deepEqual(validateProfile({ ...profile, configuration: 'Release', allowAutomaticPullRequests: false }), profile);
    assert.doesNotThrow(() => validateProfile({ ...profile, device: undefined }));
    assert.throws(() => validateProfile({ ...profile, device: null }), /Invalid saved/);
    assert.throws(() => validateProfile({ ...profile, projectPath: '../App.csproj' }), /relative/);
    assert.throws(() => validateProfile({ ...profile, configuration: 'Invalid' }), /Invalid/);
});

function deploymentHarness() {
    const filename = path.resolve(__dirname, '../out/branchDeploy.js');
    const localRequire = createRequire(filename);
    const root = path.resolve('/application');
    const repository = { root, commonDirectory: path.join(root, '.git'), worktreePath: `${root}-mauideploy` };
    const profile = {
        version: 1, repositoryRoot: root, commonDirectory: repository.commonDirectory,
        remote: 'origin', repositoryUrl: 'https://github.com/example/app', projectPath: 'src/App.csproj',
        configuration: 'Release', device: { id: 'configured', name: 'Configured Phone', platform: 'iOS', type: 'physical' },
        allowAutomaticPullRequests: false
    };
    const source = parseRepositoryUrl(profile.repositoryUrl);
    const reference = { repository: source, number: 42 };
    const fixture = {
        profile, reference, repository, trusted: true, confirms: [], builds: [], fetches: [],
        events: [], saves: [], pickerCount: 0, head: { repository: source, commit: 'a'.repeat(40) },
        remoteUrl: profile.repositoryUrl, cancelPicker: false, remoteOffline: false,
        hasProfile: true, setupResult: 'success', setupCalls: [], folderPicks: 0,
        devicePicks: [], profileWrites: [], cancelDevice: false, abortDevice: false,
        projects: ['src/App.csproj', 'src/Other.csproj'], remotes: ['origin'], commands: new Map(), failures: [],
        platforms: [{ name: 'iOS', framework: 'net10.0-ios' }],
        workspaceFolders: [{ uri: { fsPath: root } }],
        token: { isCancellationRequested: false, onCancellationRequested: handler => {
            fixture.cancel = () => { fixture.token.isCancellationRequested = true; handler(); };
            return { dispose() {} };
        } }
    };
    let setupModule;
    const device = { ...profile.device, state: 'connected', display: profile.device.name };
    fixture.devices = [device];
    const sandbox = {
        exports: {}, process, AbortController,
        require: name => {
            if (name === 'vscode') {
                return {
                    workspace: { get isTrusted() { return fixture.trusted; }, get workspaceFolders() { return fixture.workspaceFolders; } },
                    CancellationError: class extends Error {},
                    CancellationTokenSource: class {
                        token = { isCancellationRequested: false };
                        cancel() { this.token.isCancellationRequested = true; }
                        dispose() {}
                    },
                    ThemeIcon: class {}, QuickPickItemKind: { Separator: -1 },
                    commands: {
                        registerCommand: (name, handler) => { fixture.commands.set(name, handler); return { dispose() {} }; }
                    },
                    window: {
                        showWarningMessage: async message => { fixture.confirms.push(message); return fixture.confirmAnswer; },
                        showInformationMessage: async () => {},
                        showErrorMessage: async message => fixture.failures.push(message),
                        showQuickPick: async (items, options, token) => {
                            if (items.some(item => item.device)) {
                                assert.equal(token, fixture.token);
                                fixture.devicePicks.push(items.filter(item => item.device));
                                if (fixture.cancelDevice) { return undefined; }
                                if (fixture.abortDevice) { fixture.cancel(); }
                                if (fixture.selectedDeviceId) { return items.find(item => item.device?.id === fixture.selectedDeviceId); }
                                return items.find(item => item.device);
                            }
                            fixture.setupCalls.push(items);
                            assert.equal(fixture.fetches.length, 0);
                            assert.equal(fixture.builds.length, 0);
                            assert.equal(token.isCancellationRequested, false);
                            if (fixture.setupResult === 'cancel' || fixture.setupCancelAt === fixture.setupCalls.length) { return undefined; }
                            if (fixture.setupResult === 'abort') {
                                fixture.cancel();
                                assert.equal(token.isCancellationRequested, true);
                                return undefined;
                            }
                            if (fixture.setupResult === 'failed') { throw new Error('Setup failed'); }
                            return items.find(item => item.choice?.value === (fixture.selectedProject ?? profile.projectPath)) ?? items[0];
                        },
                        showOpenDialog: async () => {
                            fixture.folderPicks++;
                            return fixture.chosenFolder ? [{ fsPath: fixture.chosenFolder }] : undefined;
                        },
                        createTerminal: () => assert.fail('Setup must use native VS Code menus'),
                        createQuickPick: () => {
                            fixture.pickerCount++;
                            const handlers = {};
                            const picker = { value: '', selectedItems: [], dispose() {}, show() {} };
                            for (const name of ['onDidHide', 'onDidChangeValue', 'onDidAccept']) {
                                picker[name] = handler => { handlers[name] = handler; return { dispose() {} }; };
                            }
                            Object.defineProperty(picker, 'items', { set: items => {
                                queueMicrotask(() => {
                                    if (fixture.cancelPicker) { handlers.onDidHide(); return; }
                                    picker.selectedItems = [items.find(item => item.source)];
                                    handlers.onDidAccept();
                                });
                            } });
                            return picker;
                        }
                    }
                };
            }
            if (name === './branchProfiles') {
                return {
                    readBranchProfiles: async () => fixture.hasProfile ? [validateProfile(profile)] : [],
                    readBranchProfile: async () => fixture.hasProfile ? validateProfile(profile) : undefined,
                    saveBranchProfile: async value => {
                        if (fixture.setupResult === 'not-saved') { throw new Error('Could not save profile'); }
                        if (!fixture.hasProfile) { fixture.events.push(['setup-complete']); }
                        fixture.hasProfile = true;
                        fixture.profileWrites.push(value);
                        Object.assign(profile, value);
                    },
                    resolveDeploymentProject: async (directory, relative) => path.join(directory, relative)
                };
            }
            if (name === './branchSetup') {
                if (!setupModule) {
                    const setupFilename = path.resolve(__dirname, '../out/branchSetup.js');
                    const setupSandbox = { exports: {}, module: {}, process, require: sandbox.require };
                    vm.runInNewContext(fs.readFileSync(setupFilename, 'utf8'), setupSandbox, { filename: setupFilename });
                    setupModule = setupSandbox.exports;
                }
                return setupModule;
            }
            if (name === './worktrees') {
                return {
                    getGitRepository: async () => repository,
                    runGit: async (directory, args) => {
                        if (args[0] === 'remote') { return args.length === 1 ? fixture.remotes.join('\n') : fixture.remoteUrl; }
                        if (args[0] === 'ls-files') { return fixture.projects.join('\0'); }
                        return 'feature/local';
                    },
                    withDeploymentWorktree: async (repo, commit, deploy) => {
                        fixture.events.push(['worktree', repo.worktreePath, commit]);
                        return deploy(repo.worktreePath);
                    }
                };
            }
            if (name === './branchSources') {
                return {
                    ...localRequire(name),
                    listBranches: async () => {
                        if (fixture.remoteOffline) { throw new Error('Offline'); }
                        return [{ name: 'feature/selected', remote: 'origin' }];
                    },
                    listMatchingRemotes: async (repo, expected) => {
                        return sameRepository(parseRepositoryUrl(fixture.remoteUrl), expected) ? ['origin'] : [];
                    },
                    getPullRequestHead: async () => { fixture.events.push(['head']); return fixture.head; },
                    fetchPullRequestCommit: async (...args) => { fixture.fetches.push(args); return fixture.head.commit; },
                    resolveBranchCommit: async (repo, branch) => { fixture.events.push(['branch', branch]); return fixture.head.commit; }
                };
            }
            if (name === './devices') {
                return {
                    isMauiProject: () => true,
                    detectPlatforms: () => fixture.platforms,
                    detectAllDevices: async platforms => fixture.devices.filter(device => platforms.some(platform => platform.name === device.platform)),
                    bootSimulator: async () => assert.fail('A physical device must not be booted')
                };
            }
            if (name === './deployer') {
                return { buildAndDeploy: async (...args) => { fixture.builds.push(args); return { success: true, durationMs: 5 }; } };
            }
            return localRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const context = {
        asAbsolutePath: relative => path.join('/extension', relative),
        subscriptions: [], environmentVariableCollection: { prepend() {}, replace() {} },
        globalState: { get: () => undefined, update: async (...args) => fixture.saves.push(args) }
    };
    fixture.run = request => sandbox.exports.deployBranch(context, fixture.token, () => {}, undefined, request);
    fixture.registerSetup = () => sandbox.exports.registerBranchSetup(context, () => path.join(root, profile.projectPath));
    return fixture;
}

test('a same-repository PR uses Debug without legacy permission or configuration prompts', async () => {
    const fixture = deploymentHarness();
    assert.equal((await fixture.run(fixture.reference)).success, true);
    assert.equal(fixture.confirms.length, 0);
    assert.equal(fixture.setupCalls.length, 0);
    assert.equal(fixture.pickerCount, 0);
    assert.equal(fixture.devicePicks.length, 1);
    assert.equal(fixture.fetches.length, 1);
    const [project, platform, device, configuration, token, progress, terminal] = fixture.builds[0];
    assert.equal(project, path.join(fixture.repository.worktreePath, 'src/App.csproj'));
    assert.equal(platform.framework, 'net10.0-ios');
    assert.equal(device.id, 'configured');
    assert.equal(configuration, 'Debug');
    assert.equal(token, fixture.token);
    assert.equal(typeof progress, 'function');
    assert.equal(terminal, 'MAUI Deploy - Branch');
    assert.equal(fixture.saves.length, 0);
});

test('every branch and PR deployment requires device selection, even with only one connected device', async () => {
    for (const fromPullRequest of [true, false]) {
        const fixture = deploymentHarness();
        for (let deployment = 0; deployment < 2; deployment++) {
            await fixture.run(fromPullRequest ? fixture.reference : undefined);
        }
        assert.equal(fixture.devicePicks.length, 2);
        assert.equal(fixture.builds.length, 2);
        assert.ok(fixture.builds.every(args => args[3] === 'Debug'));
        assert.equal(fixture.confirms.length, 0);
        assert.ok(fixture.devicePicks.every(items => items.length === 1));
    }
});

test('device choice can switch platforms, remembers the last choice and excludes unavailable or unsupported targets', async () => {
    const fixture = deploymentHarness();
    fixture.platforms.push({ name: 'Android', framework: 'net10.0-android' });
    fixture.devices.push(
        { id: 'android', name: 'Pixel', display: 'Pixel', platform: 'Android', type: 'physical', state: 'connected' },
        { id: 'offline', name: 'Offline', display: 'Offline', platform: 'iOS', type: 'physical', available: false },
        { id: 'unsupported', platform: 'Windows', type: 'physical' }
    );
    fixture.selectedDeviceId = 'android';
    await fixture.run(fixture.reference);
    assert.equal(fixture.devicePicks[0][0].device.id, 'configured');
    assert.deepEqual(Array.from(fixture.devicePicks[0], item => item.device.id), ['configured', 'android']);
    assert.equal(fixture.builds[0][1].framework, 'net10.0-android');
    assert.equal(fixture.builds[0][2].id, 'android');
    assert.equal(fixture.profile.device.id, 'android');
    fixture.selectedDeviceId = undefined;
    await fixture.run(fixture.reference);
    assert.equal(fixture.devicePicks[1][0].device.id, 'android');
    assert.equal(fixture.devicePicks.length, 2);
});

test('cancelled device selection never builds or overwrites the last device', async () => {
    for (const abortDevice of [false, true]) {
        const fixture = deploymentHarness();
        fixture.cancelDevice = !abortDevice;
        fixture.abortDevice = abortDevice;
        await assert.rejects(fixture.run(fixture.reference));
        assert.equal(fixture.builds.length, 0);
        assert.equal(fixture.profileWrites.length, 0);
        assert.equal(fixture.profile.device.id, 'configured');
    }
});

test('first deployment has no device default and a disconnected last device does not block choosing another', async () => {
    const fixture = deploymentHarness();
    fixture.profile.device = undefined;
    await fixture.run(fixture.reference);
    assert.equal(fixture.devicePicks.length, 1);
    fixture.devices = [{ id: 'replacement', name: 'Other Phone', display: 'Other Phone', platform: 'iOS', type: 'physical' }];
    await fixture.run(fixture.reference);
    assert.equal(fixture.builds[1][2].id, 'replacement');
    fixture.devices = [];
    await assert.rejects(fixture.run(fixture.reference), /No available devices/);
    assert.equal(fixture.builds.length, 2);
});

test('first PR click uses native setup menus and selects the device once before resuming the same PR', async () => {
    const fixture = deploymentHarness();
    fixture.hasProfile = false;
    assert.equal((await fixture.run(fixture.reference)).success, true);
    assert.equal(fixture.setupCalls.length, 1);
    assert.equal(fixture.profileWrites[0].device, undefined);
    assert.equal(fixture.profileWrites[0].projectPath, 'src/App.csproj');
    assert.equal(fixture.profileWrites[0].configuration, 'Debug');
    assert.equal(Object.hasOwn(fixture.profileWrites[0], 'allowAutomaticPullRequests'), false);
    assert.equal(fixture.devicePicks.length, 1);
    assert.equal(fixture.fetches[0][2], fixture.reference);
    assert.equal(fixture.pickerCount, 0);
    assert.equal(fixture.folderPicks, 0);
    assert.equal(fixture.confirms.length, 0);
    assert.ok(fixture.events.findIndex(event => event[0] === 'setup-complete') < fixture.events.findIndex(event => event[0] === 'head'));
    await fixture.run(fixture.reference);
    assert.equal(fixture.setupCalls.length, 1);
    assert.equal(fixture.devicePicks.length, 2);
    assert.equal(fixture.builds.length, 2);
});

test('native setup cancellation, failure or save failure never fetches or deploys', async () => {
    for (const setupResult of ['cancel', 'abort', 'failed', 'not-saved']) {
        const fixture = deploymentHarness();
        fixture.hasProfile = false;
        fixture.setupResult = setupResult;
        await assert.rejects(fixture.run(fixture.reference));
        assert.equal(fixture.hasProfile, false);
        assert.equal(fixture.fetches.length, 0);
        assert.equal(fixture.builds.length, 0);
    }
});

test('cancelling any setup menu preserves the previous configuration without partial saves', async () => {
    for (const setupCancelAt of [1, 2]) {
        const fixture = deploymentHarness();
        fixture.remotes = ['origin', 'upstream'];
        fixture.registerSetup();
        fixture.selectedProject = 'src/Other.csproj';
        fixture.setupCancelAt = setupCancelAt;
        await fixture.commands.get('mauideploy.setupBranchDeploy')();
        assert.equal(fixture.profileWrites.length, 0);
        assert.equal(fixture.profile.projectPath, 'src/App.csproj');
        assert.equal(fixture.devicePicks.length, 0);
        assert.equal(fixture.failures.length, 0);
    }
});

test('command palette setup uses the same menus, preserves the last device and never starts a deployment', async () => {
    const fixture = deploymentHarness();
    fixture.registerSetup();
    fixture.selectedProject = 'src/Other.csproj';
    await fixture.commands.get('mauideploy.setupBranchDeploy')();
    assert.equal(fixture.profile.projectPath, 'src/Other.csproj');
    assert.equal(fixture.profile.configuration, 'Debug');
    assert.equal(fixture.profile.device.id, 'configured');
    assert.equal(fixture.devicePicks.length, 0);
    assert.equal(fixture.profileWrites.length, 1);
    assert.equal(fixture.builds.length, 0);
    assert.equal(fixture.failures.length, 0);
});

test('single project and remote choices are automatic, but the device picker is never skipped', async () => {
    const fixture = deploymentHarness();
    fixture.projects = ['src/App.csproj'];
    fixture.hasProfile = false;
    await fixture.run(fixture.reference);
    assert.equal(fixture.setupCalls.length, 0);
    assert.equal(fixture.devicePicks.length, 1);
});

test('a PR without an open matching repository can select a local clone, but not another repository', async () => {
    const fixture = deploymentHarness();
    fixture.hasProfile = false;
    fixture.workspaceFolders = [];
    fixture.chosenFolder = fixture.repository.root;
    assert.equal((await fixture.run(fixture.reference)).success, true);
    assert.equal(fixture.folderPicks, 1);
    assert.equal(fixture.setupCalls.length, 1);
    for (const chosenFolder of [undefined, fixture.repository.root]) {
        const invalid = deploymentHarness();
        invalid.hasProfile = false;
        invalid.remoteUrl = 'https://github.com/other/repository';
        invalid.chosenFolder = chosenFolder;
        await assert.rejects(invalid.run(invalid.reference));
        assert.equal(invalid.setupCalls.length, 0);
        assert.equal(invalid.fetches.length, 0);
        assert.equal(invalid.builds.length, 0);
    }
});

test('the branch button also starts setup on first use without changing ordinary deployment state', async () => {
    const fixture = deploymentHarness();
    fixture.hasProfile = false;
    assert.equal((await fixture.run()).success, true);
    assert.equal(fixture.setupCalls.length, 1);
    assert.equal(fixture.pickerCount, 1);
    assert.ok(fixture.saves.every(entry => entry[0].startsWith('mauideploy.branch.')));
});

test('fork PRs still require explicit consent and device selection before building', async () => {
    const fixture = deploymentHarness();
    fixture.head.repository = parseRepositoryUrl('https://github.com/contributor/app');
    assert.equal(await fixture.run(fixture.reference), undefined);
    assert.equal(fixture.confirms.length, 1);
    assert.equal(fixture.fetches.length, 0);
    assert.equal(fixture.devicePicks.length, 0);
    assert.equal(fixture.builds.length, 0);
    fixture.confirmAnswer = 'Build & Deploy';
    assert.equal((await fixture.run(fixture.reference)).success, true);
    assert.equal(fixture.devicePicks.length, 1);
    assert.equal(fixture.builds.length, 1);
    assert.equal(fixture.builds[0][3], 'Debug');
});

test('untrusted workspaces, changed remotes, wrong repositories and cancelled operations never build', async () => {
    for (const scenario of ['untrusted', 'remote', 'repository', 'cancelled']) {
        const fixture = deploymentHarness();
        if (scenario === 'untrusted') { fixture.trusted = false; }
        if (scenario === 'remote') { fixture.remoteUrl = 'https://github.com/other/app'; }
        if (scenario === 'repository') { fixture.reference.repository = parseRepositoryUrl('https://github.com/other/app'); }
        if (scenario === 'cancelled') { fixture.token.isCancellationRequested = true; }
        await assert.rejects(fixture.run(fixture.reference));
        assert.equal(fixture.events.length, 0);
        assert.equal(fixture.fetches.length, 0);
        assert.equal(fixture.builds.length, 0);
    }
});

test('the branch button always requires a selection, remembers it separately and works with local branches offline', async () => {
    for (const remoteOffline of [false, true]) {
        const fixture = deploymentHarness();
        fixture.remoteOffline = remoteOffline;
        assert.equal((await fixture.run()).success, true);
        assert.equal(fixture.pickerCount, 1);
        const chosen = fixture.events.find(event => event[0] === 'branch')[1];
        assert.equal(chosen.name, remoteOffline ? 'feature/local' : 'feature/selected');
        assert.equal(fixture.saves.length, 1);
        assert.match(fixture.saves[0][0], /^mauideploy\.branch\./);
    }
    const cancelled = deploymentHarness();
    cancelled.cancelPicker = true;
    assert.equal(await cancelled.run(), undefined);
    assert.equal(cancelled.builds.length, 0);
    assert.equal(cancelled.saves.length, 0);
});

test('terminal setup skips configuration and permissions and migrates old profiles without losing project or device', async context => {
    const fixture = repositoryFixture(context);
    git(fixture.root, 'remote', 'add', 'origin', 'https://github.com/example/app.git');
    fs.writeFileSync(path.join(fixture.root, 'App.csproj'), '<Project><PropertyGroup><UseMaui>true</UseMaui><TargetFramework>net10.0-ios</TargetFramework></PropertyGroup></Project>');
    const before = git(fixture.root, 'status', '--porcelain=v1');
    const home = path.join(path.dirname(fixture.root), 'home');
    const profileFile = path.resolve(__dirname, '../out/branchProfiles.js');
    const profileRequire = createRequire(profileFile);
    const profileSandbox = {
        exports: {}, process,
        require: name => name === 'os' ? { ...os, homedir: () => home } : profileRequire(name)
    };
    vm.runInNewContext(fs.readFileSync(profileFile, 'utf8'), profileSandbox, { filename: profileFile });
    const profileApi = profileSandbox.exports;
    const setupFile = path.resolve(__dirname, '../out/branchSetup.js');
    const setupRequire = createRequire(setupFile);
    const setupSandbox = {
        exports: {}, module: {}, process,
        require: name => {
            if (name === 'process') { return { stdin: {}, stdout: { write() {} } }; }
            if (name === 'readline/promises') {
                return { createInterface: () => ({ question: async () => assert.fail('Unexpected setup question'), close() {} }) };
            }
            if (name === './branchProfiles') { return profileApi; }
            if (name === './devices') { return { ...setupRequire(name), detectAllDevices: async () => assert.fail('Setup must not choose a device') }; }
            return setupRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(setupFile, 'utf8'), setupSandbox, { filename: setupFile });
    await setupSandbox.exports.setupBranchDeploy(fixture.root);
    const repository = await getGitRepository(fixture.root);
    let profile = await profileApi.readBranchProfile(repository);
    assert.equal(profile.projectPath, 'App.csproj');
    assert.equal(profile.configuration, 'Debug');
    assert.equal(profile.device, undefined);
    assert.equal(Object.hasOwn(profile, 'allowAutomaticPullRequests'), false);
    assert.equal((await profileApi.readBranchProfiles()).length, 1);
    profile.device = { id: 'last-used', name: 'Phone', platform: 'iOS', type: 'physical' };
    const profileDirectory = path.join(home, '.mauideploy', 'branch-deploy');
    const storedProfileFile = path.join(profileDirectory, fs.readdirSync(profileDirectory)[0]);
    fs.writeFileSync(storedProfileFile, JSON.stringify({ ...profile, configuration: 'Release', allowAutomaticPullRequests: false }));
    assert.equal((await profileApi.readBranchProfile(repository)).configuration, 'Debug');
    assert.equal((await profileApi.readBranchProfiles())[0].configuration, 'Debug');
    await setupSandbox.exports.setupBranchDeploy(fixture.root);
    profile = await profileApi.readBranchProfile(repository);
    assert.equal(profile.configuration, 'Debug');
    assert.equal(profile.device.id, 'last-used');
    const storedProfile = JSON.parse(fs.readFileSync(storedProfileFile, 'utf8'));
    assert.equal(storedProfile.configuration, 'Debug');
    assert.equal(Object.hasOwn(storedProfile, 'allowAutomaticPullRequests'), false);
    assert.equal((await profileApi.readBranchProfiles()).length, 1);
    assert.equal(git(fixture.root, 'status', '--porcelain=v1'), before);
    assert.equal(fs.existsSync(repository.worktreePath), false);

    git(fixture.root, 'remote', 'set-url', 'origin', 'https://github.com/contributor/app.git');
    git(fixture.root, 'remote', 'add', 'upstream', 'https://github.com/example/app.git');
    await setupSandbox.exports.setupBranchDeploy(fixture.root, 'https://github.com/example/app');
    profile = await profileApi.readBranchProfile(repository);
    assert.equal(profile.remote, 'upstream');
    assert.equal(profile.repositoryUrl, 'https://github.com/example/app');
    assert.equal(profile.configuration, 'Debug');
    await assert.rejects(setupSandbox.exports.setupBranchDeploy(fixture.root, 'https://github.com/other/app'), /No Git remote matches/);
    assert.equal((await profileApi.readBranchProfile(repository)).remote, 'upstream');
});