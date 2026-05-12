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

The VS Code extension lives in `mauideploy-vscode/` and is configured with publisher id `vetle444`.

To publish publicly in the VS Code Marketplace:

1. Create a Marketplace publisher at https://marketplace.visualstudio.com/manage.
2. Make sure the publisher id matches `publisher` in `mauideploy-vscode/package.json`.
3. Create an Azure DevOps Personal Access Token with the `Marketplace > Manage` scope.
4. Log in with vsce:

```bash
cd mauideploy-vscode
npx @vscode/vsce login vetle444
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

## Version Updates

Before publishing a new version, update `version` in `mauideploy-vscode/package.json`, then run:

```bash
cd mauideploy-vscode
npm install --package-lock-only
npx @vscode/vsce publish
```