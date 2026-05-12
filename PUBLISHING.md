# Publishing

## GitHub

The repository is published at:

```text
https://github.com/Vetle444/MauiDeploy
```

Clone it with submodules so the Mono debugger libraries are restored:

```bash
git clone --recurse-submodules https://github.com/Vetle444/MauiDeploy.git
```

For an existing clone, restore submodules with:

```bash
git submodule update --init --recursive
```

## Visual Studio Marketplace

The VS Code extension lives in `mauideploy-vscode/` and is configured with publisher id `DIPS`.

To publish publicly in the VS Code Marketplace:

1. Create a Marketplace publisher at https://marketplace.visualstudio.com/manage.
2. Make sure the publisher id matches `publisher` in `mauideploy-vscode/package.json`.
3. Create an Azure DevOps Personal Access Token with the `Marketplace > Manage` scope.
4. Log in with vsce:

```bash
cd mauideploy-vscode
npx @vscode/vsce login DIPS
```

5. Build and publish the extension:

```bash
cd ../MauiDeploy.Debugger
dotnet publish -c Release -o ../mauideploy-vscode/out/debugger/

cd ../mauideploy-vscode
npm install
npm run compile
npx @vscode/vsce publish
```

Use `npx @vscode/vsce package` first when you want to inspect the VSIX before publishing.

## Update The Extension Package

Use this flow whenever you want to ship a new VSIX or publish a new Marketplace version.

1. Make sure the repository is up to date:

```bash
git checkout main
git pull --recurse-submodules
git submodule update --init --recursive
```

2. Update the source code and test the change locally.

3. Bump `version` in `mauideploy-vscode/package.json` using semantic versioning:

- Patch version for fixes, for example `0.2.0` to `0.2.1`
- Minor version for new features, for example `0.2.0` to `0.3.0`
- Major version for breaking changes, for example `0.2.0` to `1.0.0`

4. Sync the lockfile after changing the package version:

```bash
cd mauideploy-vscode
npm install --package-lock-only
```

5. Rebuild the bundled debug adapter:

```bash
cd ../MauiDeploy.Debugger
dotnet publish -c Release -o ../mauideploy-vscode/out/debugger/
```

6. Compile and package the VS Code extension:

```bash
cd ../mauideploy-vscode
npm install
npm run compile
npm run package
```

7. Install the generated VSIX locally and reload VS Code:

```bash
code --install-extension mauideploy-*.vsix --force
```

8. Smoke test the extension from VS Code:

- Confirm the MAUI Deploy status bar controls appear in a MAUI workspace.
- Select a project and device.
- Run or debug a sample app.
- Check `MAUI Deploy: Open Logs` if anything fails.

9. Commit and push the package update:

```bash
git status
git add .
git commit -m "Release MAUI Deploy VERSION"
git push
```

10. Publish to the VS Code Marketplace:

```bash
cd mauideploy-vscode
npx @vscode/vsce publish
```

If you only want to create a local VSIX and not publish publicly, stop after `npm run package`.