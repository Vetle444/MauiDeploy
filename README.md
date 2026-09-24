# MauiDeploy


MauiDeploy is a self-contained .NET MAUI deployment toolkit with three pieces:

- `MauiDeploy/` - console deploy tool built with Spectre.Console
- `MauiDeploy.Debugger/` - Mono SDB to VS Code Debug Adapter Protocol bridge
- `mauideploy-vscode/` - VS Code extension for selecting projects, choosing devices, building, deploying existing builds, running tests, and debugging MAUI apps

The VS Code extension does not depend on C# Dev Kit or DotNet.Meteor. The debugger is published into the extension package and launched with `dotnet`.

## Build

Build the debug adapter into the extension output folder:

```bash
cd MauiDeploy.Debugger
dotnet publish -c Release -o ../mauideploy-vscode/out/debugger/
```

Compile the VS Code extension and its webviews:

```bash
cd ../mauideploy-vscode
npm ci
npm --prefix memory-inspector ci
npm run compile
npm run build:memory
```

Package the extension:

```bash
npm run package
```

Install the local VSIX for testing:

```bash
code --install-extension mauideploy-*.vsix --force
```

Reload VS Code after installing the VSIX.

## Requirements

- Node.js 22.12+ for building and packaging the extension
- .NET SDK for the MAUI app target frameworks
- Xcode command line tools for iOS simulator and physical iOS deployment
- Android SDK platform tools for Android deployment
- VS Code 1.85 or newer

## Repository

GitHub: https://github.com/Vetle444/MauiDeploy

See `PUBLISHING.md` for GitHub clone and VS Code Marketplace publishing steps.
